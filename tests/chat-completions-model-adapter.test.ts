import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatCompletionsModelAdapter } from '../packages/adapters/src/chat-completions-model-adapter.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('calls configurable chat-completions endpoint without leaking token', async () => {
  let requestedUrl = '';
  let authorization = '';
  let requestBody = '';
  const adapter = new ChatCompletionsModelAdapter({
    baseUrl: 'http://127.0.0.1:8080',
    model: 'local-model',
    providerName: 'local-test',
    apiKey: 'secret-model-token',
    supportsJsonMode: true,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      requestBody = String(init?.body ?? '');
      return jsonResponse({
        model: 'local-model',
        choices: [{ message: { content: '{"goal":"ok","steps":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });

  const result = await adapter.complete({
    messages: [{ role: 'user', content: 'planifica' }],
    temperature: 0,
    responseFormat: 'json',
  });

  assert.equal(requestedUrl, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(authorization, 'Bearer secret-model-token');
  assert.match(requestBody, /json_object/);
  assert.equal(result.provider, 'local-test');
  assert.equal(result.text, '{"goal":"ok","steps":[]}');
  assert.equal(JSON.stringify(result).includes('secret-model-token'), false);
});

test('works without authorization header for local no-auth runtimes', async () => {
  let authorization: string | null = 'not-called';
  const adapter = new ChatCompletionsModelAdapter({
    baseUrl: 'http://localhost:9999',
    model: 'offline-model',
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return jsonResponse({
        choices: [{ message: { content: 'local answer' } }],
      });
    },
  });

  const result = await adapter.complete({
    messages: [{ role: 'user', content: 'hola' }],
  });

  assert.equal(authorization, null);
  assert.equal(result.text, 'local answer');
});

test('returns provider error without echoing credentials', async () => {
  const adapter = new ChatCompletionsModelAdapter({
    baseUrl: 'https://models.example.test',
    model: 'model-x',
    apiKey: 'top-secret',
    fetchImpl: async () => jsonResponse({ error: { message: 'model unavailable' } }, 503),
  });

  await assert.rejects(
    () => adapter.complete({ messages: [{ role: 'user', content: 'hola' }] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /503/);
      assert.equal(error.message.includes('top-secret'), false);
      return true;
    },
  );
});
