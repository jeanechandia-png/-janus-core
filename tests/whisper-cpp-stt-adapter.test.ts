import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpeechInputChunk } from '../packages/gateways/src/contracts.js';
import {
  WhisperCppSttAdapter,
  pcm16MonoWav,
} from '../packages/adapters/src/whisper-cpp-stt-adapter.js';

const PCM_MIME = 'audio/pcm;rate=16000;channels=1;format=s16le';

test('whisper.cpp adapter endpoints local PCM speech and posts an in-memory WAV', async () => {
  let requests = 0;
  let wavBytes: Uint8Array | undefined;
  let detectLanguage: FormDataEntryValue | null = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    requests += 1;
    assert.equal(String(input), 'http://127.0.0.1:8080/inference');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.body instanceof FormData);
    const form = init.body;
    const file = form.get('file');
    assert.ok(file && typeof file !== 'string');
    wavBytes = new Uint8Array(await file.arrayBuffer());
    detectLanguage = form.get('detect_language');
    assert.equal(form.get('response_format'), 'json');
    return new Response(JSON.stringify({ text: '  hola Janus  ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const adapter = new WhisperCppSttAdapter({
    baseUrl: 'http://127.0.0.1:8080',
    fetchImpl,
    partialIntervalMs: 0,
    preRollMs: 40,
    silenceMs: 120,
    minSpeechMs: 100,
  });

  const events = [];
  for await (const event of adapter.transcribeStream(testUtterance())) events.push(event);

  assert.equal(requests, 1);
  assert.equal(detectLanguage, 'true');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { text: 'hola Janus', final: true });
  assert.ok(wavBytes);
  assert.equal(ascii(wavBytes, 0, 4), 'RIFF');
  assert.equal(ascii(wavBytes, 8, 4), 'WAVE');
  assert.equal(ascii(wavBytes, 36, 4), 'data');
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.ok(wavBytes.byteLength > 44);
});

test('whisper.cpp adapter keeps audio on loopback unless remote access is explicit', () => {
  assert.throws(
    () => new WhisperCppSttAdapter({ baseUrl: 'https://speech.example.com' }),
    /local-only by default/,
  );
  assert.doesNotThrow(
    () => new WhisperCppSttAdapter({
      baseUrl: 'https://speech.example.com',
      allowRemote: true,
      partialIntervalMs: 0,
    }),
  );
});

test('whisper.cpp adapter rejects incompatible audio before network access', async () => {
  let called = false;
  const adapter = new WhisperCppSttAdapter({
    baseUrl: 'http://localhost:8080',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
    partialIntervalMs: 0,
  });

  async function* badAudio(): AsyncIterable<SpeechInputChunk> {
    yield {
      bytes: new Uint8Array([0, 0, 0, 0]),
      mimeType: 'audio/webm',
      sequence: 1,
    };
  }

  await assert.rejects(async () => {
    for await (const _event of adapter.transcribeStream(badAudio())) {
      // No event is expected.
    }
  }, /requires audio\/pcm/);
  assert.equal(called, false);
});

test('WAV encoder preserves PCM payload length', () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const wav = pcm16MonoWav(pcm);
  assert.equal(wav.byteLength, 50);
  assert.deepEqual(Array.from(wav.slice(44)), Array.from(pcm));
});

async function* testUtterance(): AsyncIterable<SpeechInputChunk> {
  let sequence = 0;
  for (let index = 0; index < 2; index += 1) {
    yield chunk(++sequence, 0, 20);
  }
  for (let index = 0; index < 8; index += 1) {
    yield chunk(++sequence, 0.18, 20);
  }
  for (let index = 0; index < 7; index += 1) {
    yield chunk(++sequence, 0, 20);
  }
}

function chunk(sequence: number, amplitude: number, durationMs: number): SpeechInputChunk {
  const samples = Math.round(16_000 * durationMs / 1000);
  const buffer = new ArrayBuffer(samples * 2);
  const view = new DataView(buffer);
  const value = Math.round(Math.max(-1, Math.min(1, amplitude)) * 32767);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, value, true);
  }
  return {
    bytes: new Uint8Array(buffer),
    mimeType: PCM_MIME,
    sequence,
  };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}
