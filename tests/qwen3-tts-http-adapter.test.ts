import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Qwen3TtsHttpAdapter,
  parsePcmContentType,
} from '../packages/adapters/src/qwen3-tts-http-adapter.js';

const PCM_MIME = 'audio/pcm;rate=24000;channels=1;format=s16le';

test('Qwen3 TTS adapter keeps synthesis local and chunks typed PCM output', async () => {
  const pcm = new Uint8Array(24_000 * 2 / 10); // 100 ms mono PCM16 at 24 kHz.
  for (let index = 0; index < pcm.length; index += 2) {
    pcm[index] = index % 256;
    pcm[index + 1] = 0;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8090/synthesize');
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>)['content-type'], 'application/json');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, {
      text: 'Hola Jean',
      voiceId: 'janus-canonical',
      language: 'Spanish',
      instruct: 'calm and precise',
    });
    return new Response(pcm.slice().buffer, {
      status: 200,
      headers: { 'content-type': PCM_MIME },
    });
  };

  const adapter = new Qwen3TtsHttpAdapter({
    baseUrl: 'http://127.0.0.1:8090',
    fetchImpl,
    language: 'Spanish',
    instruct: 'calm and precise',
    chunkMs: 40,
  });

  const chunks = [];
  for await (const chunk of adapter.synthesize('Hola Jean', 'janus-canonical')) chunks.push(chunk);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.mimeType, PCM_MIME);
  assert.equal(chunks[0]?.bytes.byteLength, 1_920);
  assert.equal(chunks[1]?.bytes.byteLength, 1_920);
  assert.equal(chunks[2]?.bytes.byteLength, 960);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0), pcm.byteLength);
});

test('Qwen3 TTS adapter rejects remote audio providers unless explicitly enabled', () => {
  assert.throws(
    () => new Qwen3TtsHttpAdapter({ baseUrl: 'https://voice.example.com' }),
    /local-only by default/,
  );
  assert.doesNotThrow(
    () => new Qwen3TtsHttpAdapter({ baseUrl: 'https://voice.example.com', allowRemote: true }),
  );
});

test('Qwen3 TTS adapter rejects untyped or unsupported audio', async () => {
  const adapter = new Qwen3TtsHttpAdapter({
    baseUrl: 'http://localhost:8090',
    fetchImpl: async () => new Response(new Uint8Array([1, 2]).buffer, {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    }),
  });

  await assert.rejects(async () => {
    for await (const _chunk of adapter.synthesize('hola', 'voice')) {
      // No compatible chunks expected.
    }
  }, /must return typed PCM audio/);
});

test('PCM content type parser normalizes supported format', () => {
  assert.deepEqual(
    parsePcmContentType('audio/pcm; channels=1; format=s16le; rate=24000'),
    {
      mimeType: PCM_MIME,
      sampleRate: 24_000,
      channels: 1,
      bytesPerFrame: 2,
    },
  );
  assert.equal(parsePcmContentType('audio/pcm;rate=24000;channels=1;format=f32le'), null);
});
