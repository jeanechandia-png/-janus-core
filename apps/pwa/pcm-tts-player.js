export function parsePcmMimeType(mimeType) {
  if (typeof mimeType !== 'string') return null;
  const parts = mimeType.split(';').map((part) => part.trim());
  if (parts[0]?.toLowerCase() !== 'audio/pcm') return null;

  const params = new Map();
  for (const part of parts.slice(1)) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    params.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim().toLowerCase());
  }

  const sampleRate = Number(params.get('rate'));
  const channels = Number(params.get('channels'));
  const format = params.get('format');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return null;
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) return null;
  if (format !== 's16le') return null;

  return { sampleRate, channels, format };
}

export class PcmTtsPlayer {
  constructor(options = {}) {
    this.audioContextFactory = options.audioContextFactory ?? (() => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('AudioContext no está disponible.');
      return new AudioContextClass({ latencyHint: 'interactive' });
    });
    this.context = null;
    this.nextStartTime = 0;
    this.sources = new Set();
    this.generation = 0;
  }

  async enqueue(arrayBuffer, mimeType) {
    if (!(arrayBuffer instanceof ArrayBuffer)) throw new Error('TTS PCM debe recibirse como ArrayBuffer.');
    const format = parsePcmMimeType(mimeType);
    if (!format) throw new Error(`Formato TTS PCM no compatible: ${mimeType ?? 'desconocido'}`);

    const bytesPerFrame = format.channels * 2;
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength % bytesPerFrame !== 0) {
      throw new Error('Frame TTS PCM inválido.');
    }

    const context = await this.ensureContext();
    const generation = this.generation;
    const view = new DataView(arrayBuffer);
    const frameCount = arrayBuffer.byteLength / bytesPerFrame;
    const buffer = context.createBuffer(format.channels, frameCount, format.sampleRate);

    for (let channel = 0; channel < format.channels; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const offset = (frame * format.channels + channel) * 2;
        output[frame] = view.getInt16(offset, true) / 32768;
      }
    }

    if (generation !== this.generation) return;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.015, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  interrupt() {
    this.generation += 1;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Source ya finalizada.
      }
      try {
        source.disconnect();
      } catch {
        // No hay conexión activa.
      }
    }
    this.sources.clear();
    this.nextStartTime = 0;
  }

  async close() {
    this.interrupt();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }

  async ensureContext() {
    if (!this.context || this.context.state === 'closed') {
      this.context = this.audioContextFactory();
      this.nextStartTime = 0;
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context;
  }
}
