import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import type {
  SpeechInputChunk,
  TranscriptEvent,
  VoiceGateway,
} from '../packages/gateways/src/contracts.js';
import { VoiceSessionRegistry } from '../packages/voice/src/registry.js';
import { VoiceStreamServer } from '../packages/voice/src/websocket-transport.js';

const TTS_MIME = 'audio/pcm;rate=24000;channels=1;format=s16le';

class SocketTestGateway implements VoiceGateway {
  private ttsRelease?: () => void;
  private readonly ttsGate = new Promise<void>((resolve) => {
    this.ttsRelease = resolve;
  });

  releaseTts(): void {
    this.ttsRelease?.();
    this.ttsRelease = undefined;
  }

  async *transcribeStream(chunks: AsyncIterable<SpeechInputChunk>): AsyncIterable<TranscriptEvent> {
    for await (const chunk of chunks) {
      if (chunk.sequence === 1) {
        yield { text: 'revisa GitHub', final: true, language: 'es' };
      }
    }
  }

  async *synthesize(_text: string, _voiceId: string) {
    yield { bytes: new Uint8Array([10, 11]), mimeType: TTS_MIME };
    await this.ttsGate;
    yield { bytes: new Uint8Array([12, 13]), mimeType: TTS_MIME };
    yield { bytes: new Uint8Array([14, 15]), mimeType: TTS_MIME };
  }
}

test('WebSocket voice stream carries audio, transcript action, TTS metadata and barge-in', async () => {
  const runs: string[] = [];
  const sessions = new VoiceSessionRegistry(() => ({
    start: async (text) => {
      runs.push(text);
      return 'run_ws_1';
    },
    pause: async () => {},
    resume: async () => {},
    cancel: async () => {},
  }));

  const http = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');

  const gateway = new SocketTestGateway();
  const transport = new VoiceStreamServer({
    server: http,
    sessions,
    gatewayFactory: async () => gateway,
    defaultVoiceId: 'janus-test',
  });
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice/stream`);
  const jsonMessages: Array<Record<string, unknown>> = [];
  const binaryMessages: Uint8Array[] = [];
  const receivedOrder: string[] = [];

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      binaryMessages.push(new Uint8Array(data as Buffer));
      receivedOrder.push('binary');
      if (binaryMessages.length === 1) {
        client.send(JSON.stringify({ type: 'speech.start' }));
      }
      return;
    }
    const parsed: unknown = JSON.parse(data.toString());
    if (!isRecord(parsed)) return;
    jsonMessages.push(parsed);
    if (parsed.type === 'speech.audio') receivedOrder.push('speech.audio');
    if (parsed.type === 'speech.ack' && parsed.state === 'started') {
      gateway.releaseTts();
    }
  });

  try {
    await once(client, 'open');
    client.send(JSON.stringify({
      type: 'hello',
      version: 1,
      sessionId: 'iphone-test',
      voiceId: 'janus-test',
      audio: { mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le' },
    }));
    await waitFor(() => jsonMessages.some((message) => message.type === 'ready'));

    client.send(Buffer.from([1, 2, 3, 4]));
    await waitFor(() => jsonMessages.some((message) => message.type === 'session.action'));
    assert.deepEqual(runs, ['revisa GitHub']);

    const action = jsonMessages.find((message) => message.type === 'session.action');
    assert.ok(isRecord(action?.result));
    assert.equal(action.result.kind, 'task');
    assert.equal(action.result.runId, 'run_ws_1');

    const startedSpeaking = transport.speak('iphone-test', 'Voy a explicarlo ahora.');
    await waitFor(() => binaryMessages.length >= 1);
    await waitFor(() => jsonMessages.some((message) => message.type === 'speech.ack' && message.state === 'started'));
    await startedSpeaking;

    assert.equal(binaryMessages.length, 1);
    const audioMeta = jsonMessages.find((message) => message.type === 'speech.audio');
    assert.ok(audioMeta);
    assert.equal(audioMeta.mimeType, TTS_MIME);
    assert.equal(audioMeta.sequence, 1);
    assert.equal(audioMeta.byteLength, 2);
    assert.deepEqual(receivedOrder.slice(0, 2), ['speech.audio', 'binary']);

    const interrupted = jsonMessages.find((message) => message.type === 'speech.interrupted');
    assert.ok(interrupted);
    assert.equal(interrupted.reason, 'barge-in');
    assert.equal(transport.connectedSessionIds().includes('iphone-test'), true);
    assert.equal(sessions.get('iphone-test').snapshot().microphoneConnected, true);
  } finally {
    gateway.releaseTts();
    client.close();
    await transport.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('WebSocket stream rejects audio before hello and oversized frames', async () => {
  const sessions = new VoiceSessionRegistry(() => ({
    start: async () => 'run',
    pause: async () => {},
    resume: async () => {},
    cancel: async () => {},
  }));
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');

  const transport = new VoiceStreamServer({
    server: http,
    sessions,
    gatewayFactory: async () => new SocketTestGateway(),
    maxAudioFrameBytes: 4,
  });
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice/stream`);
  const messages: Array<Record<string, unknown>> = [];
  client.on('message', (data, isBinary) => {
    if (isBinary) return;
    const parsed: unknown = JSON.parse(data.toString());
    if (isRecord(parsed)) messages.push(parsed);
  });

  try {
    await once(client, 'open');
    client.send(Buffer.from([1]));
    await waitFor(() => messages.some((message) => message.code === 'not_ready'));

    client.send(JSON.stringify({
      type: 'hello',
      version: 1,
      sessionId: 'size-test',
      audio: { mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le' },
    }));
    await waitFor(() => messages.some((message) => message.type === 'ready'));
    client.send(Buffer.from([1, 2, 3, 4, 5]));
    await waitFor(() => messages.some((message) => message.code === 'frame_too_large'));
  } finally {
    client.close();
    await transport.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached before timeout');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
