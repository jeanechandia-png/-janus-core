import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  ['--import', 'tsx', 'apps/runtime/server.ts'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      JANUS_DB: ':memory:',
      JANUS_TIME_ZONE: 'Europe/Amsterdam',
      GOOGLE_ACCESS_TOKEN: '',
      JANUS_MODEL_BASE_URL: '',
      JANUS_MODEL_NAME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const health = await waitForJson(`${base}/health`, 8_000);
  assert.equal(health.ok, true);
  assert.equal(health.service, 'janus-runtime');
  assert.equal(health.durable, true);
  assert.equal(health.db, 'memory');
  assert.equal(health.timeZone, 'Europe/Amsterdam');

  const capabilities = Array.isArray(health.capabilities) ? health.capabilities : [];
  const github = capabilities.find((item) => item?.tool === 'github' && item?.action === 'repo.get');
  const google = capabilities.find(
    (item) => item?.tool === 'google-workspace' && item?.action === 'calendar.events.list',
  );
  assert.equal(github?.state, 'available');
  assert.equal(google?.state, 'needs_auth');

  const localRunId = await startCommand(base, 'haz una tarea local sin herramienta');
  const localRun = await waitForRun(base, localRunId, new Set(['completed', 'failed', 'blocked']), 5_000);
  assert.equal(localRun.status, 'completed');

  const googleRunId = await startCommand(base, 'mira mi calendario');
  const googleRun = await waitForRun(base, googleRunId, new Set(['completed', 'failed', 'blocked']), 5_000);
  assert.equal(googleRun.status, 'blocked');

  const eventsResponse = await fetch(`${base}/api/events?runId=${encodeURIComponent(googleRunId)}`, {
    headers: { accept: 'text/event-stream' },
    signal: AbortSignal.timeout(500),
  }).catch((error) => {
    if (error?.name === 'TimeoutError') return null;
    throw error;
  });
  if (eventsResponse) eventsResponse.body?.cancel();

  console.log('runtime smoke ok');
} catch (error) {
  console.error('JANUS runtime smoke failed');
  if (stdout) console.error('--- runtime stdout ---\n' + stdout);
  if (stderr) console.error('--- runtime stderr ---\n' + stderr);
  throw error;
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (!child.killed) child.kill('SIGKILL');
}

async function startCommand(baseUrl, text) {
  const response = await fetch(`${baseUrl}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, inputMode: 'text' }),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.runId, 'string');
  return body.runId;
}

async function waitForRun(baseUrl, runId, terminalStates, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`);
    if (response.ok) {
      const body = await response.json();
      last = body.snapshot;
      if (terminalStates.has(last?.status)) return last;
    }
    await delay(50);
  }
  throw new Error(`run ${runId} did not reach terminal state; last=${JSON.stringify(last)}`);
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(75);
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const selected = address.port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
