import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleWorkspaceAdapter } from '../packages/adapters/src/google-workspace-adapter.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Drive search uses bearer auth without exposing the token in the result', async () => {
  const seen: { url?: string; authorization?: string } = {};
  const adapter = new GoogleWorkspaceAdapter({
    accessToken: 'secret-google-token',
    fetchImpl: async (input, init) => {
      seen.url = String(input);
      seen.authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      return jsonResponse({
        files: [{ id: 'f1', name: 'Janus Estado', mimeType: 'application/pdf' }],
      });
    },
  });

  const result = await adapter.execute(
    {
      tool: 'google-workspace',
      action: 'drive.files.search',
      input: { query: 'Janus' },
    },
    async () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(seen.authorization, 'Bearer secret-google-token');
  assert.match(seen.url ?? '', /drive\/v3\/files/);
  const driveUrl = new URL(seen.url ?? 'https://invalid.local');
  assert.equal(driveUrl.searchParams.get('q'), "name contains 'Janus' and trashed = false");
  assert.equal(JSON.stringify(result).includes('secret-google-token'), false);
});

test('Gmail search resolves list IDs into safe message metadata', async () => {
  const urls: string[] = [];
  const adapter = new GoogleWorkspaceAdapter({
    accessToken: 'ephemeral',
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/messages?')) {
        return jsonResponse({
          messages: [{ id: 'm1', threadId: 't1' }],
          resultSizeEstimate: 1,
        });
      }
      return jsonResponse({
        id: 'm1',
        threadId: 't1',
        snippet: 'Factura pendiente',
        internalDate: '1',
        payload: {
          headers: [
            { name: 'Subject', value: 'Factura' },
            { name: 'From', value: 'billing@example.com' },
            { name: 'Date', value: 'Sun, 13 Sep 2026 10:00:00 +0200' },
          ],
        },
      });
    },
  });

  const result = await adapter.execute(
    {
      tool: 'google-workspace',
      action: 'gmail.messages.search',
      input: { query: 'is:unread factura', maxResults: 5 },
    },
    async () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(urls.length, 2);
  const [listUrl] = urls;
  assert.ok(listUrl);
  assert.equal(new URL(listUrl).searchParams.get('q'), 'is:unread factura');
  const output = result.output as { messages?: Array<Record<string, unknown>> } | undefined;
  assert.equal(output?.messages?.[0]?.subject, 'Factura');
  assert.equal(output?.messages?.[0]?.from, 'billing@example.com');
});

test('Calendar lists a bounded upcoming window by default', async () => {
  let requestedUrl = '';
  const adapter = new GoogleWorkspaceAdapter({
    accessToken: 'ephemeral',
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        timeZone: 'Europe/Amsterdam',
        items: [{ id: 'e1', summary: 'Incluzio' }],
      });
    },
  });

  const result = await adapter.execute(
    {
      tool: 'google-workspace',
      action: 'calendar.events.list',
      input: { calendarId: 'primary', maxResults: 10 },
    },
    async () => {},
  );

  assert.equal(result.ok, true);
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get('singleEvents'), 'true');
  assert.equal(url.searchParams.get('orderBy'), 'startTime');
  assert.ok(url.searchParams.get('timeMin'));
  assert.ok(url.searchParams.get('timeMax'));
});

test('adapter fails closed when no Google credential provider exists', async () => {
  const adapter = new GoogleWorkspaceAdapter({
    fetchImpl: async () => {
      throw new Error('fetch should not be called');
    },
  });

  const result = await adapter.execute(
    {
      tool: 'google-workspace',
      action: 'drive.files.search',
      input: {},
    },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not authenticated/i);
});
