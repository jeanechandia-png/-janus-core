import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('PCM AudioWorklet downsamples 48 kHz input into 20 ms PCM16 frames at 16 kHz', async () => {
  const source = await readFile(new URL('../apps/pwa/pcm-capture-worklet.js', import.meta.url), 'utf8');
  const messages: Array<{ message: Record<string, unknown>; transfers?: unknown[] }> = [];
  let Processor: any;

  class MockAudioWorkletProcessor {
    readonly port = {
      postMessage: (message: Record<string, unknown>, transfers?: unknown[]) => {
        messages.push({ message, transfers });
      },
    };
  }

  vm.runInNewContext(source, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    sampleRate: 48_000,
    registerProcessor: (name: string, ctor: any) => {
      assert.equal(name, 'janus-pcm-capture');
      Processor = ctor;
    },
    Float32Array,
    Int16Array,
    Number,
    Math,
  });

  assert.ok(Processor);
  const processor = new Processor({
    processorOptions: { targetSampleRate: 16_000, frameMs: 20 },
  });

  let sampleOffset = 0;
  for (let block = 0; block < 12; block += 1) {
    const samples = new Float32Array(128);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((2 * Math.PI * 440 * (sampleOffset + index)) / 48_000) * 0.2;
    }
    sampleOffset += samples.length;
    assert.equal(processor.process([[samples]]), true);
  }

  assert.ok(messages.length >= 1);
  const first = messages[0]?.message;
  assert.equal(first?.type, 'pcm');
  const pcm = first?.pcm as ArrayBuffer | undefined;
  assert.equal(pcm?.byteLength, 320 * 2);
  assert.equal((first?.rms as number) > 0.05, true);
  assert.equal(messages[0]?.transfers?.length, 1);
});

test('PCM AudioWorklet reports near-zero RMS for silence', async () => {
  const source = await readFile(new URL('../apps/pwa/pcm-capture-worklet.js', import.meta.url), 'utf8');
  const messages: Array<Record<string, unknown>> = [];
  let Processor: any;

  class MockAudioWorkletProcessor {
    readonly port = {
      postMessage: (message: Record<string, unknown>) => messages.push(message),
    };
  }

  vm.runInNewContext(source, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    sampleRate: 16_000,
    registerProcessor: (_name: string, ctor: any) => { Processor = ctor; },
    Float32Array,
    Int16Array,
    Number,
    Math,
  });

  const processor = new Processor({
    processorOptions: { targetSampleRate: 16_000, frameMs: 20 },
  });
  for (let block = 0; block < 3; block += 1) {
    processor.process([[new Float32Array(128)]]);
  }

  assert.ok(messages.length >= 1);
  assert.equal(messages[0]?.type, 'pcm');
  assert.equal(messages[0]?.rms, 0);
});
