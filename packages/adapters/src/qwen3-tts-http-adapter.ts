import type {
  SpeechOutputChunk,
  TextToSpeechGateway,
} from '../../gateways/src/contracts.js';

export interface Qwen3TtsHttpAdapterOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  allowRemote?: boolean;
  language?: string;
  instruct?: string;
  chunkMs?: number;
  requestTimeoutMs?: number;
}

interface PcmFormat {
  mimeType: string;
  sampleRate: number;
  channels: number;
  bytesPerFrame: number;
}

export class Qwen3TtsHttpAdapter implements TextToSpeechGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly language: string;
  private readonly instruct?: string;
  private readonly chunkMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: Qwen3TtsHttpAdapterOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.allowRemote === true);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.language = options.language?.trim() || 'Auto';
    this.instruct = options.instruct?.trim() || undefined;
    this.chunkMs = boundedNumber(options.chunkMs, 40, 10, 250);
    this.requestTimeoutMs = boundedNumber(options.requestTimeoutMs, 120_000, 1_000, 600_000);
  }

  async *synthesize(text: string, voiceId: string): AsyncIterable<SpeechOutputChunk> {
    const cleanText = text.trim();
    const cleanVoiceId = voiceId.trim();
    if (!cleanText) return;
    if (!cleanVoiceId) throw new Error('Qwen3 TTS voiceId is required');

    const response = await this.fetchImpl(`${this.baseUrl}/synthesize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'audio/pcm',
      },
      body: JSON.stringify({
        text: cleanText,
        voiceId: cleanVoiceId,
        language: this.language,
        ...(this.instruct ? { instruct: this.instruct } : {}),
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Qwen3 TTS sidecar HTTP ${response.status}: ${safePreview(body)}`);
    }

    const contentType = response.headers.get('content-type')?.trim() || '';
    const format = parsePcmContentType(contentType);
    if (!format) {
      throw new Error(`Qwen3 TTS sidecar must return typed PCM audio; received '${contentType || 'missing content-type'}'`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength % format.bytesPerFrame !== 0) {
      throw new Error('Qwen3 TTS sidecar returned a truncated PCM frame');
    }

    const chunkBytes = alignedChunkBytes(format, this.chunkMs);
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const end = Math.min(bytes.byteLength, offset + chunkBytes);
      yield {
        bytes: bytes.slice(offset, end),
        mimeType: format.mimeType,
      };
    }
  }
}

export function parsePcmContentType(contentType: string): PcmFormat | null {
  const parts = contentType.split(';').map((part) => part.trim());
  if (parts[0]?.toLowerCase() !== 'audio/pcm') return null;

  const params = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    params.set(
      part.slice(0, separator).trim().toLowerCase(),
      part.slice(separator + 1).trim().toLowerCase(),
    );
  }

  const sampleRate = Number(params.get('rate'));
  const channels = Number(params.get('channels'));
  const sampleFormat = params.get('format');
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) return null;
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) return null;
  if (sampleFormat !== 's16le') return null;

  return {
    mimeType: `audio/pcm;rate=${sampleRate};channels=${channels};format=s16le`,
    sampleRate,
    channels,
    bytesPerFrame: channels * 2,
  };
}

function alignedChunkBytes(format: PcmFormat, chunkMs: number): number {
  const frames = Math.max(1, Math.round((format.sampleRate * chunkMs) / 1000));
  return frames * format.bytesPerFrame;
}

function normalizeBaseUrl(value: string, allowRemote: boolean): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Qwen3 TTS sidecar URL must use http or https');
  }
  if (!allowRemote && !isLoopbackHost(url.hostname)) {
    throw new Error('Qwen3 TTS is local-only by default; set allowRemote=true explicitly for non-loopback hosts');
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

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

function safePreview(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 240) || 'request failed';
}
