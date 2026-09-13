import type {
  SpeechInputChunk,
  SpeechToTextGateway,
  TranscriptEvent,
} from '../../gateways/src/contracts.js';

export interface WhisperCppSttAdapterOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  language?: string;
  allowRemote?: boolean;
  speechStartRms?: number;
  speechEndRms?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
  preRollMs?: number;
  partialIntervalMs?: number;
  requestTimeoutMs?: number;
}

const PCM_MIME = 'audio/pcm;rate=16000;channels=1;format=s16le';
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

export class WhisperCppSttAdapter implements SpeechToTextGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly language: string;
  private readonly speechStartRms: number;
  private readonly speechEndRms: number;
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxUtteranceMs: number;
  private readonly preRollMs: number;
  private readonly partialIntervalMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: WhisperCppSttAdapterOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.allowRemote === true);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.language = options.language?.trim() || 'auto';
    this.speechStartRms = options.speechStartRms ?? 0.018;
    this.speechEndRms = options.speechEndRms ?? 0.010;
    this.silenceMs = options.silenceMs ?? 650;
    this.minSpeechMs = options.minSpeechMs ?? 250;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 20_000;
    this.preRollMs = options.preRollMs ?? 240;
    this.partialIntervalMs = options.partialIntervalMs ?? 1_200;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async *transcribeStream(
    chunks: AsyncIterable<SpeechInputChunk>,
  ): AsyncIterable<TranscriptEvent> {
    let preRoll: Uint8Array[] = [];
    let preRollBytes = 0;
    let active: Uint8Array[] = [];
    let activeBytes = 0;
    let speaking = false;
    let silenceDuration = 0;
    let sincePartial = 0;
    let lastPartial = '';

    for await (const chunk of chunks) {
      assertPcmChunk(chunk);
      const durationMs = pcmDurationMs(chunk.bytes.byteLength);
      const rms = pcm16Rms(chunk.bytes);

      if (!speaking) {
        ({ frames: preRoll, totalBytes: preRollBytes } = appendPreRoll(
          preRoll,
          preRollBytes,
          chunk.bytes,
          msToPcmBytes(this.preRollMs),
        ));

        if (rms < this.speechStartRms) continue;

        speaking = true;
        active = preRoll.map((frame) => frame.slice());
        activeBytes = preRollBytes;
        preRoll = [];
        preRollBytes = 0;
        silenceDuration = 0;
        sincePartial = pcmDurationMs(activeBytes);
      } else {
        active.push(chunk.bytes.slice());
        activeBytes += chunk.bytes.byteLength;
        sincePartial += durationMs;
      }

      if (rms <= this.speechEndRms) {
        silenceDuration += durationMs;
      } else {
        silenceDuration = 0;
      }

      const activeDuration = pcmDurationMs(activeBytes);
      if (
        this.partialIntervalMs > 0
        && sincePartial >= this.partialIntervalMs
        && activeDuration >= this.minSpeechMs
      ) {
        const partial = await this.infer(active, activeBytes);
        if (partial && partial !== lastPartial) {
          lastPartial = partial;
          yield {
            text: partial,
            final: false,
            ...(this.language !== 'auto' ? { language: this.language } : {}),
          };
        }
        sincePartial = 0;
      }

      const reachedEndpoint = silenceDuration >= this.silenceMs && activeDuration >= this.minSpeechMs;
      const reachedLimit = activeDuration >= this.maxUtteranceMs;
      if (!reachedEndpoint && !reachedLimit) continue;

      const finalText = await this.infer(active, activeBytes);
      if (finalText) {
        yield {
          text: finalText,
          final: true,
          ...(this.language !== 'auto' ? { language: this.language } : {}),
        };
      }

      speaking = false;
      active = [];
      activeBytes = 0;
      silenceDuration = 0;
      sincePartial = 0;
      lastPartial = '';
    }

    if (speaking && activeBytes > 0) {
      const finalText = await this.infer(active, activeBytes);
      if (finalText) {
        yield {
          text: finalText,
          final: true,
          ...(this.language !== 'auto' ? { language: this.language } : {}),
        };
      }
    }
  }

  private async infer(frames: Uint8Array[], totalBytes: number): Promise<string> {
    const pcm = concatBytes(frames, totalBytes);
    const wav = pcm16MonoWav(pcm, SAMPLE_RATE);
    const wavBuffer = new ArrayBuffer(wav.byteLength);
    new Uint8Array(wavBuffer).set(wav);
    const form = new FormData();
    form.set('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'janus-utterance.wav');
    form.set('response_format', 'json');
    form.set('temperature', '0.0');
    form.set('temperature_inc', '0.2');
    form.set('no_speech_thold', '0.6');
    if (this.language === 'auto') {
      form.set('detect_language', 'true');
    } else {
      form.set('language', this.language);
    }

    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const response = await this.fetchImpl(`${this.baseUrl}/inference`, {
      method: 'POST',
      body: form,
      signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`whisper.cpp HTTP ${response.status}: ${safePreview(text)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('whisper.cpp returned invalid JSON');
    }
    if (!isRecord(parsed) || typeof parsed.text !== 'string') {
      throw new Error('whisper.cpp response is missing text');
    }
    return parsed.text.trim();
  }
}

function assertPcmChunk(chunk: SpeechInputChunk): void {
  if (chunk.mimeType !== PCM_MIME) {
    throw new Error(`whisper.cpp adapter requires ${PCM_MIME}`);
  }
  if (chunk.bytes.byteLength % BYTES_PER_SAMPLE !== 0) {
    throw new Error('PCM16 frame has an odd byte length');
  }
}

function pcm16Rms(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = bytes.byteLength / BYTES_PER_SAMPLE;
  let sum = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += BYTES_PER_SAMPLE) {
    const sample = view.getInt16(offset, true) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

function pcmDurationMs(byteLength: number): number {
  return (byteLength / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
}

function msToPcmBytes(ms: number): number {
  return Math.max(0, Math.round((ms / 1000) * SAMPLE_RATE * BYTES_PER_SAMPLE));
}

function appendPreRoll(
  frames: Uint8Array[],
  totalBytes: number,
  frame: Uint8Array,
  maxBytes: number,
): { frames: Uint8Array[]; totalBytes: number } {
  const next = [...frames, frame.slice()];
  let bytes = totalBytes + frame.byteLength;
  while (bytes > maxBytes && next.length > 1) {
    const removed = next.shift();
    if (removed) bytes -= removed.byteLength;
  }
  if (bytes > maxBytes && next[0]) {
    const keep = Math.max(0, maxBytes);
    const current = next[0];
    next[0] = current.slice(Math.max(0, current.byteLength - keep));
    bytes = next[0].byteLength;
  }
  return { frames: next, totalBytes: bytes };
}

function concatBytes(frames: Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.byteLength;
  }
  return output;
}

export function pcm16MonoWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataLength = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLength, true);
  new Uint8Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function normalizeBaseUrl(value: string, allowRemote: boolean): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('whisper.cpp base URL must use http or https');
  }
  if (!allowRemote && !isLoopbackHost(url.hostname)) {
    throw new Error('whisper.cpp audio is local-only by default; set allowRemote=true explicitly for non-loopback hosts');
  }
  return url.toString().replace(/\/$/, '');
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized.startsWith('127.');
}

function safePreview(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 240) || 'request failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
