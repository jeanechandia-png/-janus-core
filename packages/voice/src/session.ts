export type VoiceSessionPhase = 'idle' | 'listening' | 'working' | 'paused' | 'blocked';

export interface VoiceTranscript {
  text: string;
  final: boolean;
  language?: string;
}

export interface VoiceRunController {
  start(text: string): Promise<string>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
}

export interface VoiceSessionSnapshot {
  sessionId: string;
  phase: VoiceSessionPhase;
  microphoneConnected: boolean;
  speaking: boolean;
  activeRunId?: string;
  lastTranscript?: string;
  updatedAt: string;
}

export interface VoiceSessionOptions {
  sessionId: string;
  runs: VoiceRunController;
  now?: () => Date;
}

export interface VoiceUtteranceResult {
  handled: boolean;
  kind: 'interim' | 'command' | 'task';
  action?: 'pause' | 'resume' | 'cancel';
  runId?: string;
}

export class VoiceSessionController {
  private phase: VoiceSessionPhase = 'idle';
  private microphoneConnected = false;
  private speaking = false;
  private activeRunId?: string;
  private lastTranscript?: string;
  private updatedAt: string;
  private readonly sessionId: string;
  private readonly runs: VoiceRunController;
  private readonly nowProvider?: () => Date;

  constructor(options: VoiceSessionOptions) {
    this.sessionId = options.sessionId;
    this.runs = options.runs;
    this.nowProvider = options.now;
    this.updatedAt = this.now();
  }

  snapshot(): VoiceSessionSnapshot {
    return {
      sessionId: this.sessionId,
      phase: this.phase,
      microphoneConnected: this.microphoneConnected,
      speaking: this.speaking,
      activeRunId: this.activeRunId,
      lastTranscript: this.lastTranscript,
      updatedAt: this.updatedAt,
    };
  }

  microphone(state: 'connected' | 'disconnected'): VoiceSessionSnapshot {
    this.microphoneConnected = state === 'connected';
    if (!this.microphoneConnected && !this.activeRunId) this.phase = 'idle';
    if (this.microphoneConnected && !this.activeRunId) this.phase = 'listening';
    this.touch();
    return this.snapshot();
  }

  tts(state: 'started' | 'completed'): VoiceSessionSnapshot {
    this.speaking = state === 'started';
    this.touch();
    return this.snapshot();
  }

  async transcript(input: VoiceTranscript): Promise<VoiceUtteranceResult> {
    const text = input.text.trim();
    if (!text) return { handled: false, kind: 'interim' };

    this.lastTranscript = text;
    this.touch();
    if (!input.final) return { handled: true, kind: 'interim', runId: this.activeRunId };

    const control = parseControlIntent(text);
    if (control && this.activeRunId) {
      const runId = this.activeRunId;
      if (control === 'pause') {
        await this.runs.pause(runId);
        this.phase = 'paused';
      }
      if (control === 'resume') {
        await this.runs.resume(runId);
        this.phase = 'working';
      }
      if (control === 'cancel') {
        await this.runs.cancel(runId);
        this.activeRunId = undefined;
        this.phase = this.microphoneConnected ? 'listening' : 'idle';
      }
      this.touch();
      return { handled: true, kind: 'command', action: control, runId };
    }

    const runId = await this.runs.start(text);
    this.activeRunId = runId;
    this.phase = 'working';
    this.touch();
    return { handled: true, kind: 'task', runId };
  }

  runCompleted(runId: string): VoiceSessionSnapshot {
    if (this.activeRunId === runId) {
      this.activeRunId = undefined;
      this.phase = this.microphoneConnected ? 'listening' : 'idle';
      this.touch();
    }
    return this.snapshot();
  }

  runBlocked(runId: string): VoiceSessionSnapshot {
    if (this.activeRunId === runId) {
      this.phase = 'blocked';
      this.touch();
    }
    return this.snapshot();
  }

  private touch(): void {
    this.updatedAt = this.now();
  }

  private now(): string {
    return (this.nowProvider?.() ?? new Date()).toISOString();
  }
}

export function parseControlIntent(text: string): 'pause' | 'resume' | 'cancel' | null {
  const intent = normalize(text);
  if (/^(janus\s+)?(pausa|pausar|espera)$/.test(intent)) return 'pause';
  if (/^(janus\s+)?(continua|continuar|sigue|reanuda|reanudar)$/.test(intent)) return 'resume';
  if (/^(janus\s+)?(para|detente|detener|cancela|cancelar)$/.test(intent)) return 'cancel';
  return null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
