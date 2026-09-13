import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const moduleUrl = pathToFileURL(resolve('apps/pwa/pcm-tts-player.js')).href;
const { PcmTtsPlayer, parsePcmMimeType } = await import(moduleUrl);

class FakeAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(
    channelCount: number,
    frameCount: number,
    sampleRate: number,
  ) {
    this.duration = frameCount / sampleRate;
    this.channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  }

  getChannelData(index: number): Float32Array {
    const channel = this.channels[index];
    if (!channel) throw new Error('missing channel');
    return channel;
  }
}

class FakeSource {
  buffer?: FakeAudioBuffer;
  onended?: () => void;
  startedAt?: number;
  stopped = false;

  connect(): void {}
  disconnect(): void {}
  start(at: number): void { this.startedAt = at; }
  stop(): void { this.stopped = true; }
}

class FakeAudioContext {
  currentTime = 1;
  state = 'running';
  destination = {};
  readonly sources: FakeSource[] = [];
  closed = false;

  createBuffer(channels: number, frames: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, frames, sampleRate);
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.state = 'closed'; this.closed = true; }
}

test('PCM player parses canonical mono PCM format', () => {
  assert.deepEqual(
    parsePcmMimeType('audio/pcm;rate=24000;channels=1;format=s16le'),
    { sampleRate: 24_000, channels: 1, format: 's16le' },
  );
  assert.equal(parsePcmMimeType('audio/wav'), null);
  assert.equal(parsePcmMimeType('audio/pcm;rate=24000;channels=1;format=f32le'), null);
});

test('PCM player schedules chunks contiguously and interrupt stops active sources', async () => {
  const context = new FakeAudioContext();
  const player = new PcmTtsPlayer({ audioContextFactory: () => context });
  const first = pcm16([0, 16384, -16384, 32767]);
  const second = pcm16([1000, -1000]);

  await player.enqueue(first, 'audio/pcm;rate=24000;channels=1;format=s16le');
  await player.enqueue(second, 'audio/pcm;rate=24000;channels=1;format=s16le');

  assert.equal(context.sources.length, 2);
  const source1 = context.sources[0];
  const source2 = context.sources[1];
  assert.ok(source1?.startedAt !== undefined);
  assert.ok(source2?.startedAt !== undefined);
  assert.equal(source1.startedAt, 1.015);
  assert.equal(source2.startedAt, source1.startedAt + (4 / 24_000));

  player.interrupt();
  assert.equal(source1.stopped, true);
  assert.equal(source2.stopped, true);

  await player.close();
  assert.equal(context.closed, true);
});

test('PCM player rejects malformed frames before scheduling audio', async () => {
  const context = new FakeAudioContext();
  const player = new PcmTtsPlayer({ audioContextFactory: () => context });
  await assert.rejects(
    player.enqueue(new ArrayBuffer(3), 'audio/pcm;rate=24000;channels=1;format=s16le'),
    /Frame TTS PCM inválido/,
  );
  assert.equal(context.sources.length, 0);
});

function pcm16(values: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return buffer;
}
