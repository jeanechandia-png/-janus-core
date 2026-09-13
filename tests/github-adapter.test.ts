import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubAdapter } from '../packages/adapters/src/github-adapter.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('GitHub adapter reads repository metadata without exposing credentials', async () => {
  let authorization: string | null = null;
  const adapter = new GitHubAdapter({
    token: 'test-secret',
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return jsonResponse({
        full_name: 'owner/repo',
        private: true,
        default_branch: 'main',
        description: 'demo',
        updated_at: '2026-09-13T00:00:00Z',
        html_url: 'https://github.com/owner/repo',
      });
    },
  });

  const result = await adapter.execute(
    { tool: 'github', action: 'repo.get', input: { owner: 'owner', repo: 'repo' } },
    async () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(result.output?.fullName, 'owner/repo');
  assert.equal(result.output?.private, true);
  assert.equal(authorization, 'Bearer test-secret');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});

test('GitHub adapter decodes a file safely', async () => {
  const adapter = new GitHubAdapter({
    fetchImpl: async () => jsonResponse({
      type: 'file',
      content: Buffer.from('hello Janus').toString('base64'),
      encoding: 'base64',
      sha: 'abc',
      size: 11,
      html_url: 'https://github.com/owner/repo/blob/main/README.md',
    }),
  });

  const result = await adapter.execute(
    {
      tool: 'github',
      action: 'file.read',
      input: { owner: 'owner', repo: 'repo', path: 'README.md' },
    },
    async () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(result.output?.content, 'hello Janus');
});

test('GitHub adapter returns API errors as tool errors', async () => {
  const adapter = new GitHubAdapter({
    fetchImpl: async () => jsonResponse({ message: 'Not Found' }, 404),
  });

  const result = await adapter.execute(
    { tool: 'github', action: 'repo.get', input: { owner: 'owner', repo: 'missing' } },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /GitHub 404: Not Found/);
});
