import { createReadStream, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventHub } from '../../packages/core/src/event-hub.js';
import { TaskRunner, type JanusStep } from '../../packages/core/src/task-runner.js';

const port = Number(process.env.PORT ?? 8787);
const root = fileURLToPath(new URL('../pwa/', import.meta.url));
const hub = new EventHub();
const runners = new Map<string, TaskRunner>();

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
      run: async ({ emit }) => {
        await emit('tool.started', 'Analizando la solicitud', { command }, 'model');
        await sleep(300);
        await emit('tool.progress', 'Objetivo y contexto identificados', { percent: 100 }, 'model');
        await emit('tool.completed', 'Solicitud preparada para ejecución', {}, 'model');
      },
    },
    {
      id: 'work',
      label: 'Ejecutar trabajo',
      run: async ({ emit }) => {
        await emit('tool.started', 'Abriendo herramientas necesarias', { tool: 'tool-gateway' }, 'tool');
        await sleep(350);
        await emit('tool.progress', 'Consultando fuentes / archivos', { percent: 35 }, 'tool');
        await sleep(350);
        await emit('tool.progress', 'Procesando resultados', { percent: 70 }, 'tool');
        await sleep(350);
        await emit('tool.completed', 'Trabajo de herramientas completado', { percent: 100 }, 'tool');
      },
    },
    {
      id: 'deliver',
      label: 'Preparar resultado',
      run: async ({ emit }) => {
        await emit('artifact.updated', 'Resultado actualizado y listo para mostrar', {
          preview: `Janus procesó: ${command}`,
        });
      },
    },
  ];
}

function startRun(command: string, inputMode: 'voice' | 'text'): string {
  const runner = new TaskRunner(command, {
    sink: hub.sink,
    approvalHandler: async (action) => ({
      approved: action.risk === 'none' || action.risk === 'low',
      reason: action.risk === 'high' ? 'La acción de alto riesgo requiere aprobación explícita.' : undefined,
    }),
  });
  const runId = runner.snapshot().runId;
  runners.set(runId, runner);

  void (async () => {
    await runner.heard(inputMode);
    await runner.execute(demoSteps(command));
  })().catch((error) => {
    console.error('run failed', error);
  });

  return runId;
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
  for (const event of hub.replay(runId)) send(event);

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
    json(response, 200, { ok: true, service: 'janus-runtime' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    handleEvents(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/command') {
    const body = await readJson(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const inputMode = body.inputMode === 'voice' ? 'voice' : 'text';
    if (!text) {
      json(response, 400, { ok: false, error: 'text is required' });
      return;
    }
    const runId = startRun(text, inputMode);
    json(response, 202, { ok: true, runId });
    return;
  }

  const control = url.pathname.match(/^\/api\/runs\/([^/]+)\/(pause|resume)$/);
  if (request.method === 'POST' && control) {
    const runner = runners.get(control[1]);
    if (!runner) {
      json(response, 404, { ok: false, error: 'run not found' });
      return;
    }
    if (control[2] === 'pause') await runner.pause();
    else await runner.resume();
    json(response, 200, { ok: true, snapshot: runner.snapshot() });
    return;
  }

  serveStatic(url.pathname, response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`JANUS runtime listening on http://0.0.0.0:${port}`);
});
