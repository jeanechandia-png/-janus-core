class JanusPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const configuredRate = Number(options?.processorOptions?.targetSampleRate);
    const configuredFrameMs = Number(options?.processorOptions?.frameMs);
    this.targetSampleRate = Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : 16000;
    this.frameMs = Number.isFinite(configuredFrameMs) && configuredFrameMs > 0 ? configuredFrameMs : 20;
    this.frameSamples = Math.max(80, Math.round(this.targetSampleRate * this.frameMs / 1000));
    this.ratio = sampleRate / this.targetSampleRate;
    this.source = new Float32Array(4096);
    this.sourceLength = 0;
    this.readPosition = 0;
    this.output = new Int16Array(this.frameSamples);
    this.outputIndex = 0;
    this.rmsAccumulator = 0;
  }

  process(inputs) {
    const channel = inputs?.[0]?.[0];
    if (!channel || channel.length === 0) return true;

    this.append(channel);
    this.resampleAvailable();
    return true;
  }

  append(channel) {
    if (this.sourceLength + channel.length > this.source.length) {
      const expanded = new Float32Array(Math.max(this.source.length * 2, this.sourceLength + channel.length + 1024));
      expanded.set(this.source.subarray(0, this.sourceLength));
      this.source = expanded;
    }
    this.source.set(channel, this.sourceLength);
    this.sourceLength += channel.length;
  }

  resampleAvailable() {
    while (this.readPosition + 1 < this.sourceLength) {
      const left = Math.floor(this.readPosition);
      const fraction = this.readPosition - left;
      const sample = this.source[left] * (1 - fraction) + this.source[left + 1] * fraction;
      this.writeSample(sample);
      this.readPosition += this.ratio;
    }

    const consumed = Math.floor(this.readPosition);
    if (consumed <= 0) return;

    const remaining = this.sourceLength - consumed;
    if (remaining > 0) this.source.copyWithin(0, consumed, this.sourceLength);
    this.sourceLength = remaining;
    this.readPosition -= consumed;
  }

  writeSample(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.rmsAccumulator += clamped * clamped;
    this.output[this.outputIndex] = clamped < 0
      ? Math.round(clamped * 0x8000)
      : Math.round(clamped * 0x7fff);
    this.outputIndex += 1;

    if (this.outputIndex < this.output.length) return;

    const frame = this.output;
    const rms = Math.sqrt(this.rmsAccumulator / frame.length);
    this.port.postMessage({ type: 'pcm', pcm: frame.buffer, rms }, [frame.buffer]);
    this.output = new Int16Array(this.frameSamples);
    this.outputIndex = 0;
    this.rmsAccumulator = 0;
  }
}

registerProcessor('janus-pcm-capture', JanusPcmCaptureProcessor);
