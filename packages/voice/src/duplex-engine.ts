import type {
  SpeechInputChunk,
  TranscriptEvent,
  VoiceGateway,
} from '../../gateways/src/contracts.js';
import type { VoiceSessionController, VoiceUtteranceResult } from './session.js';

export type DuplexVoiceEvent =
  | {
      type: 'transcript.partial' | 'transcript.final';
      text: string;
      language?: string;
    }
  | {
      type: 'speech.started';
      text: string;
      voiceId: string;
    }
  | {
      type: 'speech.chunk';
      sequence: number;
      bytes: Uint8Array;
    }
  | {
      type: 'speech.completed';
      chunks: number;
    }
  | {
      type: 'speech.interrupted';
      reason: string;
      chunks: number;
    }
  | {
      type: 'session.action';
      result: VoiceUtteranceResult;
    }
  | {
      type: 'voice.error';
      stage: 'transcription' | 'synthesis';
      message: string;
    };

export interface DuplexVoiceEngineOptions {
  gateway: VoiceGateway;
  session: VoiceSessionController;
  voiceId: string;
  onEvent: (event: DuplexVoiceEvent) => void | Promise<void>;
}

export class DuplexVoiceEngine {
  private readonly gateway: VoiceGateway;
  private readonly session: VoiceSessionController;
  private readonly voiceId: string;
  private readonly onEvent: DuplexVoiceEngineOptions['onEvent'];
  private readonly input = new AsyncQueue<SpeechInputChunk>();
  private transcriptionTask?: Promise<void>;
  private synthesisGeneration = 0;
  private synthesisActive = false;
  private lastInterruptReason = 'barge-in';
  private stopped = false;

  constructor(options: DuplexVoiceEngineOptions) {
    this.gateway = options.gateway;
    this.session = options.session;
    this.voiceId = options.voiceId;
    this.onEvent = options.onEvent;
  }

  start(): void {
    if (this.transcriptionTask || this.stopped) return;
    this.session.microphone('connected');
    this.transcriptionTask = this.consumeTranscription();
  }

  pushAudio(chunk: SpeechInputChunk): void {
    if (this.stopped) throw new Error('Duplex voice engine is stopped');
    if (!this.transcriptionTask) this.start();
    this.input.push(chunk);
  }

  userSpeechStarted(): void {
    if (this.synthesisActive) this.interruptSpeech('barge-in');
  }

  endInput(): void {
    this.input.end();
  }

  async waitForTranscription(): Promise<void> {
    await this.transcriptionTask;
  }

  async speak(text: string, voiceId = this.voiceId): Promise<void> {
    if (this.stopped) throw new Error('Duplex voice engine is stopped');
    const clean = text.trim();
    if (!clean) return;

    const generation = ++this.synthesisGeneration;
    this.lastInterruptReason = 'barge-in';
    this.synthesisActive = true;
    this.session.tts('started');
    await this.onEvent({ type: 'speech.started', text: clean, voiceId });

    let chunks = 0;
    let interrupted = false;
    let iterator: AsyncIterator<Uint8Array> | undefined;

    try {
      iterator = this.gateway.synthesize(clean, voiceId)[Symbol.asyncIterator]();
      while (true) {
        if (generation !== this.synthesisGeneration || this.stopped) {
          interrupted = true;
          break;
        }

        const next = await iterator.next();
        if (next.done) break;

        if (generation !== this.synthesisGeneration || this.stopped) {
          interrupted = true;
          break;
        }

        chunks += 1;
        await this.onEvent({
          type: 'speech.chunk',
          sequence: chunks,
          bytes: next.value,
        });
      }
    } catch (error) {
      if (generation === this.synthesisGeneration && !this.stopped) {
        await this.onEvent({
          type: 'voice.error',
          stage: 'synthesis',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      interrupted = true;
    } finally {
      if (interrupted && iterator?.return) {
        await iterator.return().catch(() => undefined);
      }
      if (generation === this.synthesisGeneration) {
        this.synthesisActive = false;
        this.session.tts('completed');
      }
    }

    if (interrupted || generation !== this.synthesisGeneration || this.stopped) {
      await this.onEvent({
        type: 'speech.interrupted',
        reason: this.stopped ? 'session-stopped' : this.lastInterruptReason,
        chunks,
      });
      return;
    }

    await this.onEvent({ type: 'speech.completed', chunks });
  }

  interruptSpeech(reason = 'barge-in'): void {
    if (!this.synthesisActive) return;
    this.lastInterruptReason = reason;
    this.synthesisGeneration += 1;
    this.synthesisActive = false;
    this.session.tts('completed');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.interruptSpeech('session-stopped');
    this.stopped = true;
    this.input.end();
    this.session.microphone('disconnected');
    await this.transcriptionTask;
  }

  private async consumeTranscription(): Promise<void> {
    try {
      for await (const event of this.gateway.transcribeStream(this.input)) {
        await this.handleTranscript(event);
      }
    } catch (error) {
      if (!this.stopped) {
        await this.onEvent({
          type: 'voice.error',
          stage: 'transcription',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async handleTranscript(event: TranscriptEvent): Promise<void> {
    await this.onEvent({
      type: event.final ? 'transcript.final' : 'transcript.partial',
      text: event.text,
      ...(event.language ? { language: event.language } : {}),
    });

    if (!event.final) return;
    const result = await this.session.transcript({
      text: event.text,
      final: true,
      ...(event.language ? { language: event.language } : {}),
    });
    await this.onEvent({ type: 'session.action', result });
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) throw new Error('Async queue has ended');
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.ended) return { value: undefined as T, done: true };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
