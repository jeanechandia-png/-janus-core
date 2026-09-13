import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { VoiceGateway } from '../../gateways/src/contracts.js';
import { DuplexVoiceEngine, type DuplexVoiceEvent } from './duplex-engine.js';
import type { VoiceSessionRegistry } from './registry.js';

export interface VoiceStreamServerOptions {
  server: HttpServer;
  sessions: VoiceSessionRegistry;
  gatewayFactory: (sessionId: string) => VoiceGateway | Promise<VoiceGateway>;
  path?: string;
  defaultVoiceId?: string;
  maxAudioFrameBytes?: number;
}

interface StreamConnection {
  sessionId: string;
  ws: WebSocket;
  engine: DuplexVoiceEngine;
  mimeType: string;
  sequence: number;
}

type ClientControl =
  | {
      type: 'hello';
      version: 1;
      sessionId: string;
      voiceId?: string;
      audio: {
        mimeType: string;
      };
    }
  | { type: 'speech.start' }
  | { type: 'speech.end' }
  | { type: 'ping'; id?: string };

export class VoiceStreamServer {
  private readonly server: HttpServer;
  private readonly sessions: VoiceSessionRegistry;
  private readonly gatewayFactory: VoiceStreamServerOptions['gatewayFactory'];
  private readonly path: string;
  private readonly defaultVoiceId: string;
  private readonly maxAudioFrameBytes: number;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly connections = new Map<string, StreamConnection>();
  private readonly onUpgradeBound: (request: IncomingMessage, socket: Socket, head: Buffer) => void;

  constructor(options: VoiceStreamServerOptions) {
    this.server = options.server;
    this.sessions = options.sessions;
    this.gatewayFactory = options.gatewayFactory;
    this.path = options.path ?? '/api/voice/stream';
    this.defaultVoiceId = options.defaultVoiceId ?? 'janus-default';
    this.maxAudioFrameBytes = options.maxAudioFrameBytes ?? 128 * 1024;
    this.onUpgradeBound = (request, socket, head) => this.onUpgrade(request, socket, head);

    this.server.on('upgrade', this.onUpgradeBound);
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  async speak(sessionId: string, text: string, voiceId?: string): Promise<boolean> {
    const connection = this.connections.get(sessionId.trim());
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return false;
    void voiceId;
    await connection.engine.speak(text);
    return true;
  }

  connectedSessionIds(): string[] {
    return [...this.connections.keys()];
  }

  async close(): Promise<void> {
    this.server.off('upgrade', this.onUpgradeBound);
    const stops = [...this.connections.values()].map(async (connection) => {
      connection.ws.close(1001, 'server shutdown');
      await connection.engine.stop();
    });
    this.connections.clear();
    await Promise.allSettled(stops);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== this.path) return;

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  private onConnection(ws: WebSocket): void {
    let connection: StreamConnection | undefined;
    let initializing = false;

    ws.on('message', (data, isBinary) => {
      void (async () => {
        if (isBinary) {
          if (!connection) {
            this.sendJson(ws, { type: 'error', code: 'not_ready', message: 'Send hello before audio.' });
            return;
          }
          const bytes = rawDataBytes(data);
          if (bytes.byteLength > this.maxAudioFrameBytes) {
            this.sendJson(ws, {
              type: 'error',
              code: 'frame_too_large',
              message: `Audio frame exceeds ${this.maxAudioFrameBytes} bytes.`,
            });
            ws.close(1009, 'audio frame too large');
            return;
          }
          connection.sequence += 1;
          connection.engine.pushAudio({
            bytes,
            mimeType: connection.mimeType,
            sequence: connection.sequence,
          });
          return;
        }

        const control = parseControl(data);
        if (!control) {
          this.sendJson(ws, { type: 'error', code: 'invalid_message', message: 'Invalid voice control message.' });
          return;
        }

        if (control.type === 'hello') {
          if (connection || initializing) {
            this.sendJson(ws, { type: 'error', code: 'already_ready', message: 'Voice stream is already initialized.' });
            return;
          }
          initializing = true;
          try {
            const sessionId = control.sessionId.trim();
            const mimeType = control.audio.mimeType.trim();
            if (!sessionId || !mimeType) throw new Error('sessionId and audio.mimeType are required');

            const existing = this.connections.get(sessionId);
            if (existing && existing.ws !== ws) {
              existing.ws.close(4001, 'session replaced');
              await existing.engine.stop();
              this.connections.delete(sessionId);
            }

            const gateway = await this.gatewayFactory(sessionId);
            const engine = new DuplexVoiceEngine({
              gateway,
              session: this.sessions.get(sessionId),
              voiceId: control.voiceId?.trim() || this.defaultVoiceId,
              onEvent: async (event) => this.forwardEngineEvent(ws, event),
            });
            connection = {
              sessionId,
              ws,
              engine,
              mimeType,
              sequence: 0,
            };
            this.connections.set(sessionId, connection);
            engine.start();
            this.sendJson(ws, {
              type: 'ready',
              version: 1,
              sessionId,
              audio: { mimeType },
            });
          } catch (error) {
            this.sendJson(ws, {
              type: 'error',
              code: 'gateway_unavailable',
              message: error instanceof Error ? error.message : String(error),
            });
            ws.close(1011, 'voice gateway unavailable');
          } finally {
            initializing = false;
          }
          return;
        }

        if (!connection) {
          this.sendJson(ws, { type: 'error', code: 'not_ready', message: 'Send hello before controls.' });
          return;
        }

        if (control.type === 'speech.start') {
          connection.engine.userSpeechStarted();
          this.sendJson(ws, { type: 'speech.ack', state: 'started' });
          return;
        }
        if (control.type === 'speech.end') {
          this.sendJson(ws, { type: 'speech.ack', state: 'ended' });
          return;
        }
        if (control.type === 'ping') {
          this.sendJson(ws, { type: 'pong', id: control.id });
        }
      })().catch((error) => {
        this.sendJson(ws, {
          type: 'error',
          code: 'stream_error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    ws.on('close', () => {
      if (!connection) return;
      const current = this.connections.get(connection.sessionId);
      if (current?.ws === ws) this.connections.delete(connection.sessionId);
      connection.engine.endInput();
      void connection.engine.stop();
    });
  }

  private async forwardEngineEvent(ws: WebSocket, event: DuplexVoiceEvent): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (event.type === 'speech.chunk') {
      ws.send(event.bytes, { binary: true });
      return;
    }
    this.sendJson(ws, event);
  }

  private sendJson(ws: WebSocket, value: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(value));
  }
}

function parseControl(data: RawData): ClientControl | null {
  try {
    const value: unknown = JSON.parse(rawDataText(data));
    if (!isRecord(value) || typeof value.type !== 'string') return null;

    if (value.type === 'hello') {
      if (value.version !== 1 || typeof value.sessionId !== 'string' || !isRecord(value.audio)) return null;
      if (typeof value.audio.mimeType !== 'string') return null;
      return {
        type: 'hello',
        version: 1,
        sessionId: value.sessionId,
        ...(typeof value.voiceId === 'string' ? { voiceId: value.voiceId } : {}),
        audio: { mimeType: value.audio.mimeType },
      };
    }
    if (value.type === 'speech.start') return { type: 'speech.start' };
    if (value.type === 'speech.end') return { type: 'speech.end' };
    if (value.type === 'ping') {
      return { type: 'ping', ...(typeof value.id === 'string' ? { id: value.id } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}

function rawDataText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
