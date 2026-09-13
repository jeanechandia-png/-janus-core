import { createReadStream, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubAdapter } from '../../packages/adapters/src/github-adapter.js';
import { EventHub } from '../../packages/core/src/event-hub.js';
import type { EventSink, RunSnapshot } from '../../packages/core/src/events.js';
import { SqliteStore } from '../../packages/core/src/sqlite-store.js';
import { TaskRunner, type JanusStep } from '../../packages/core/src/task-runner.js';
import { DefaultToolGateway } from '../../packages/gateways/src/tool-gateway.js';
import { compilePlan } from '../../packages/orchestrator/src/compile-plan.js';
import { deterministicPlan } from '../../packages/orchestrator/src/deterministic-planner.js';
import { validatePlan, type JanusPlan } from '../../packages/orchestrator/src/plan.js';
import { VoiceSessionRegistry } from '../../packages/voice/src/registry.js';

const port = Number(process.env.PORT ?? 8787);
const root = fileURLToPath(new URL('../pwa/', import.meta.url));
const dbPath = process.env.JANUS_DB ?? join(process.cwd(), 'data', 'janus.db');

const hub = new EventHub();
const store = new SqliteStore(dbPath);
const runners = new Map<string, TaskRunner>();
const toolGateway = new DefaultToolGateway();

toolGateway.register(new GitHubAdapter({ token: process.env.GITHUB_TOKEN }));

const allowedTools = new Set(['github']);
const allowedActions = new Map([
  ['github', new Set(['repo.get', 'contents.list', 'file.read'])],
]);

const voiceSessions = new VoiceSessionRegistry(() => ({
  start: async (text) => startRun(text, 'voice'),
  pause: async (runId) => controlActiveRun(runId, 'pause'),
  resume: async (runId) => controlActiveRun(runId, 'resume'),
  cancel: async (runId) => controlActiveRun(runId, 'cancel'),
}));

const interruptedRuns = store.markInterruptedRuns();
hub.hydrate(store.listEvents(undefined, 500));
if (interruptedRuns > 0) {
  console.warn(`Recovered ${interruptedRuns} interrupted Janus run(s) as blocked.`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function demoSteps(command: string): JanusStep[] {
  return [
    {
      id: 'understand',
      label: 'Entender el objetivo',
      run: async ({ emit, checkpoint }) => {
        await checkpoint();
        await emit('tool.started', 'Analizando la solicitud', { command }, 'model');
        await sleep(250);
        await checkpoint();
        await emit('tool.progress', 'Objetivo identificado; aún no hay adaptador real para esta acción', {
          percent: 100,
        }, 'model');
        await emit('tool.completed', 'Solicitud clasificada', {}, 'model');
      },
    },
    {
      id: 'deliver',
      label: 'Mostrar estado',
      run: async ({ emit, checkpoint }) => {
        await checkpoint();
        await emit('artifact.updated', 'Janus necesita un adaptador para ejecutar esta tarea', {
          preview: 'El Core entendió la orden, pero todavía no existe una herramienta real autorizada para ejecutarla.',
        });
      },
    },
  ];
}

function preparePlan(command: string): { plan: JanusPlan; steps: JanusStep[] } | null {
  const plan = deterministicPlan(command);
  if (!plan) return null;

  const validation = validatePlan(plan, {
    allowedTools,
    allowedActions,
  });

  if (!validation.ok) {
    throw new Error(`Plan rejected by Janus Core: ${validation.errors.join('; ')}`);
  }

  return {
    plan,
    steps: compilePlan(plan, { toolGateway }),
  };
}

function startRun(command: string, inputMode: 'voice' | 'text'): string {
  let runner: TaskRunner | undefined;
  const durableSink: EventSink = async (event) => {
    store.appendEvent(event);
    await hub.sink(event);
    if (runner) store.upsertRun(runner.snapshot());
  };

  runner = new TaskRunner(command, {
    sink: durableSink,
    approvalHandler: async (action) => ({
      approved: action.risk === 'none' || action.risk === 'low',
      reason: action.risk === 'high'
        ? 'La acción de alto riesgo requiere aprobación explícita.'
        : undefined,
    }),
  });

  const runId = runner.snapshot().runId;
  runners.set(runId, runner);
  store.upsertRun(runner.snapshot());
  const activeRunner = runner;

  setTimeout(() => {
    void (async () => {
      await activeRunner.heard(inputMode);

      let steps: JanusStep[];
      try {
        const prepared = preparePlan(command);
        if (prepared) {
          await durableSink({
            id: `evt_plan_${crypto.randomUUID()}`,
            runId,
            seq: activeRunner.snapshot().lastEventSeq + 1,
            type: 'artifact.updated',
            at: new Date().toISOString(),
            source: 'core',
            summary: 'Plan validado por Janus Core',
            payload: {
              preview: `${prepared.plan.steps.length} pasos autorizados · fuente ${prepared.plan.source}`,
              planVersion: prepared.plan.version,
              source: prepared.plan.source,
            },
          });
          steps = prepared.steps;
        } else {
          steps = demoSteps(command);
        }
      } catch (error) {
        await activeRunner.block('Janus Core rechazó el plan antes de ejecutar herramientas', {
          error: error instanceof Error ? error.message : String(error),
        });
        finishRun(activeRunner.snapshot());
        return;
      }

      const snapshot = await activeRunner.execute(steps);
      finishRun(snapshot);
    })().catch(async (error) => {
      console.error('run failed', error);
      voiceSessions.runBlocked(runId);
      runners.delete(runId);
    });
  }, 25);

  return runId;
}

function finishRun(snapshot: RunSnapshot): void {
  store.upsertRun(snapshot);
  if (snapshot.status === 'blocked') voiceSessions.runBlocked(snapshot.runId);
  if (snapshot.status === 'completed' || snapshot.status === 'cancelled' || snapshot.status === 'failed') {
    voiceSessions.runCompleted(snapshot.runId);
    runners.delete(snapshot.runId);
  }
}

async function controlActiveRun(
  runId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<void> {
  const runner = runners.get(runId);
  if (!runner) throw new Error('run is not active in this runtime');
  if (action === 'pause') await runner.pause();
  if (action === 'resume') await runner.resume();
  if (action === 'cancel') await runner.cancel();
  store.upsertRun(runner.snapshot());
}

function handleEvents(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const runId = url.searchParams.get('runId') ?? undefined;

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const replay = runId ? store.listEvents(runId) : hub.replay();
  for (const event of replay) send(event);

  const unsubscribe = hub.subscribe((event) => {
    if (!runId || event.runId === runId) send(event);
  });
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);

  request.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.webmanifest': return 'application/manifest+json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

function serveStatic(pathname: string, response: ServerResponse): void {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const path = join(root, requested);
  if (!path.startsWith(root) || !existsSync(path)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': contentType(path) });
  createReadStream(path).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, {
      ok: true,
      service: 'janus-runtime',
      durable: true,
      db: dbPath === ':memory:' ? 'memory' : 'sqlite',
      voiceSessionAuthority: 'core',
      planner: 'core-validated',
      tools: {
        github: ['repo.get', 'contents.list', 'file.read'],
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    handleEvents(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/command') {
    const body = await readJson(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      json(response, 400, { ok: false, error: 'text is required' });
      return;
    }
    const runId = startRun(text, body.inputMode === 'voice' ? 'voice' : 'text');
    json(response, 202, { ok: true, runId });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/voice/utterance') {
    const body = await readJson(request);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!sessionId || !text) {
      json(response, 400, { ok: false, error: 'sessionId and text are required' });
      return;
    }

    try {
      const session = voiceSessions.get(sessionId);
      const result = await session.transcript({
        text,
        final: body.final !== false,
        language: typeof body.language === 'string' ? body.language : undefined,
      });
      json(response, 200, { ok: true, result, session: session.snapshot() });
    } catch (error) {
      json(response, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/voice/microphone') {
    const body = await readJson(request);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const state = body.state === 'connected' ? 'connected' : body.state === 'disconnected' ? 'disconnected' : null;
    if (!sessionId || !state) {
      json(response, 400, { ok: false, error: 'sessionId and valid state are required' });
      return;
    }
    const session = voiceSessions.get(sessionId);
    json(response, 200, { ok: true, session: session.microphone(state) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/voice/tts') {
    const body = await readJson(request);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const state = body.state === 'started' ? 'started' : body.state === 'completed' ? 'completed' : null;
    if (!sessionId || !state) {
      json(response, 400, { ok: false, error: 'sessionId and valid state are required' });
      return;
    }
    const session = voiceSessions.get(sessionId);
    json(response, 200, { ok: true, session: session.tts(state) });
    return;
  }

  const voiceSessionMatch = url.pathname.match(/^\/api\/voice\/sessions\/([^/]+)$/);
  const voiceSessionId = voiceSessionMatch?.[1];
  if (request.method === 'GET' && voiceSessionId) {
    try {
      json(response, 200, {
        ok: true,
        session: voiceSessions.get(decodeURIComponent(voiceSessionId)).snapshot(),
      });
    } catch (error) {
      json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const getRun = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  const requestedRunId = getRun?.[1];
  if (request.method === 'GET' && requestedRunId) {
    const live = runners.get(requestedRunId)?.snapshot();
    const persisted = store.getRun(requestedRunId);
    if (!live && !persisted) {
      json(response, 404, { ok: false, error: 'run not found' });
      return;
    }
    json(response, 200, { ok: true, snapshot: live ?? persisted });
    return;
  }

  const control = url.pathname.match(/^\/api\/runs\/([^/]+)\/(pause|resume|cancel)$/);
  const controlRunId = control?.[1];
  const controlAction = control?.[2] as 'pause' | 'resume' | 'cancel' | undefined;
  if (request.method === 'POST' && controlRunId && controlAction) {
    try {
      await controlActiveRun(controlRunId, controlAction);
      json(response, 200, {
        ok: true,
        snapshot: runners.get(controlRunId)?.snapshot() ?? store.getRun(controlRunId),
      });
    } catch (error) {
      json(response, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  serveStatic(url.pathname, response);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, '0.0.0.0', () => {
  console.log(`JANUS runtime listening on http://0.0.0.0:${port}`);
});
