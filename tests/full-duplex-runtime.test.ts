import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { WebSocket } from 'ws';

const PCM_MIME = 'audio/pcm;rate=16000;channels=1;format=s16le';

test('runtime full-duplex path carries PCM through local STT, run execution, safe TTS and WebSocket audio', async () => {
  const sttRequests: Array<{ contentType: string; bytes: number }> = [];
  const ttsRequests: Array<Record<string, unknown>> = [];
  const ttsPcm = pcmFrame(6_000, 1_280); // 80 ms at 16 kHz; adapter emits two 40 ms chunks.

  const stt = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/inference') {
      response.writeHead(404).end();
      return;
    }
    const body = await readRequestBytes(request);
    sttRequests.push({
      contentType: String(request.headers['content-type'] ?? ''),
      bytes: body.byteLength,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: 'haz una tarea local por voz' }));
  });

  const tts = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/synthesize') {
      response.writeHead(404).end();
      return;
    }
    const body = Buffer.concat(await readRequestChunks(request)).toString('utf8');
    ttsRequests.push(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(200, {
      'content-type': PCM_MIME,
      'content-length': String(ttsPcm.byteLength),
    });
    response.end(ttsPcm);
  });

  const [sttPort, ttsPort, runtimePort] = await Promise.all([freePort(), freePort(), freePort()]);
  await Promise.all([
    listen(stt, sttPort),
    listen(tts, ttsPort),
  ]);

  const runtime = spawnRuntime(runtimePort, sttPort, ttsPort);
  let stdout = '';
  let stderr = '';
  runtime.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  runtime.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  let ws: WebSocket | undefined;
  const jsonMessages: Array<Record<string, any>> = [];
  const receivedBinary: Buffer[] = [];
  const ordered: Array<{ kind: 'json'; type: string; sequence?: number } | { kind: 'binary'; bytes: number }> = [];

  try {
    const health = await waitForJson(`http://127.0.0.1:${runtimePort}/health`, 8_000);
    assert.equal(health.voice?.streaming?.state, 'available');
    assert.equal(health.voice?.streaming?.transport, 'websocket');

    ws = new WebSocket(`ws://127.0.0.1:${runtimePort}/api/voice/stream`);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const bytes = Buffer.from(data as Buffer);
        receivedBinary.push(bytes);
        ordered.push({ kind: 'binary', bytes: bytes.byteLength });
        return;
      }
      const message = JSON.parse(data.toString()) as Record<string, any>;
      jsonMessages.push(message);
      ordered.push({
        kind: 'json',
        type: String(message.type ?? ''),
        ...(typeof message.sequence === 'number' ? { sequence: message.sequence } : {}),
      });
    });

    await waitForSocketOpen(ws, 5_000);
    ws.send(JSON.stringify({
      type: 'hello',
      version: 1,
      sessionId: 'full-duplex-e2e',
      voiceId: 'janus-e2e',
      audio: { mimeType: PCM_MIME },
    }));
    await waitFor(() => jsonMessages.some((message) => message.type === 'ready'), 3_000);

    const voiced = pcmFrame(12_000, 320); // 20 ms
    const silence = pcmFrame(0, 320); // 20 ms
    for (let index = 0; index < 15; index += 1) ws.send(voiced); // 300 ms speech
    for (let index = 0; index < 33; index += 1) ws.send(silence); // 660 ms silence => endpoint

    await waitFor(() => jsonMessages.some((message) => message.type === 'transcript.final'), 5_000);
    await waitFor(() => jsonMessages.some((message) => message.type === 'session.action'), 5_000);
    await waitFor(() => jsonMessages.some((message) => message.type === 'speech.completed'), 7_000);

    const transcript = jsonMessages.find((message) => message.type === 'transcript.final');
    assert.equal(transcript?.text, 'haz una tarea local por voz');

    const action = jsonMessages.find((message) => message.type === 'session.action');
    assert.equal(action?.result?.kind, 'task');
    assert.equal(typeof action?.result?.runId, 'string');

    assert.equal(sttRequests.length, 1);
    assert.match(sttRequests[0]?.contentType ?? '', /^multipart\/form-data;/i);
    assert.ok((sttRequests[0]?.bytes ?? 0) > 44, 'STT must receive a WAV payload, not an empty request');

    assert.equal(ttsRequests.length, 1);
    assert.deepEqual(ttsRequests[0], {
      text: 'Listo. El Core entendió la orden, pero todavía no existe una herramienta real autorizada para ejecutarla.',
      voiceId: 'janus-e2e',
      language: 'Auto',
    });

    assert.equal(receivedBinary.length, 2);
    assert.deepEqual(Buffer.concat(receivedBinary), ttsPcm);

    const audioMetadataIndexes = ordered
      .map((item, index) => item.kind === 'json' && item.type === 'speech.audio' ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(audioMetadataIndexes.length, 2);
    for (const metadataIndex of audioMetadataIndexes) {
      assert.equal(ordered[metadataIndex + 1]?.kind, 'binary', 'speech.audio metadata must immediately precede its binary PCM frame');
    }

    const startedIndex = ordered.findIndex((item) => item.kind === 'json' && item.type === 'speech.started');
    const firstAudioIndex = audioMetadataIndexes[0] ?? -1;
    const completedIndex = ordered.findIndex((item) => item.kind === 'json' && item.type === 'speech.completed');
    assert.ok(startedIndex >= 0 && startedIndex < firstAudioIndex);
    assert.ok(completedIndex > firstAudioIndex);
  } catch (error) {
    if (stdout) console.error('--- runtime stdout ---\n' + stdout);
    if (stderr) console.error('--- runtime stderr ---\n' + stderr);
    throw error;
  } finally {
    ws?.close();
    await stopChild(runtime);
    await Promise.all([close(stt), close(tts)]);
  }
});

function spawnRuntime(runtimePort: number, sttPort: number, ttsPort: number): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/runtime/server.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(runtimePort),
        JANUS_DB: ':memory:',
        JANUS_TIME_ZONE: 'Europe/Amsterdam',
        JANUS_STT_BASE_URL: `http://127.0.0.1:${sttPort}`,
        JANUS_TTS_BASE_URL: `http://127.0.0.1:${ttsPort}`,
        JANUS_VOICE_ID: 'janus-e2e',
        GOOGLE_ACCESS_TOKEN: '',
        JANUS_MODEL_BASE_URL: '',
        JANUS_MODEL_NAME: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

function pcmFrame(amplitude: number, samples: number): Buffer {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return buffer;
}

async function readRequestBytes(request: AsyncIterable<Uint8Array | Buffer>): Promise<Buffer> {
  return Buffer.concat(await readRequestChunks(request));
}

async function readRequestChunks(request: AsyncIterable<Uint8Array | Buffer>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks;
}

async function waitForSocketOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not open before timeout')), timeoutMs);
    const onOpen = () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

async function waitForJson(url: string, timeoutMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json() as Record<string, any>;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('condition not reached before timeout');
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(1_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
