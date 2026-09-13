import assert from 'node:assert/strict';
import test from 'node:test';
import { EventHub } from '../packages/core/src/event-hub.js';
import { TaskRunner } from '../packages/core/src/task-runner.js';
import type { ToolAdapter, ToolRequest, ToolResult } from '../packages/gateways/src/contracts.js';
import { DefaultToolGateway } from '../packages/gateways/src/tool-gateway.js';
import { compilePlan } from '../packages/orchestrator/src/compile-plan.js';
import { createPlan } from '../packages/orchestrator/src/plan.js';

function adapterFor(action: string, result: ToolResult): ToolAdapter {
  return {
    name: 'google-workspace',
    capabilities: [action],
    execute: async (request: ToolRequest, onProgress) => {
      assert.equal(request.action, action);
      await onProgress({ phase: 'started', message: 'Consultando Google Workspace' });
      await onProgress({ phase: 'completed', message: 'Consulta completada', percent: 100 });
      return result;
    },
  };
}

async function previewFor(action: string, output: Record<string, unknown>): Promise<string> {
  const gateway = new DefaultToolGateway();
  gateway.register(adapterFor(action, { ok: true, output }));

  const plan = createPlan('Mostrar resultado útil', [
    {
      id: 'google-result',
      kind: 'tool',
      label: 'Consultar Google',
      tool: 'google-workspace',
      action,
      input: {},
      risk: 'none',
      reversible: true,
      requiresApproval: false,
    },
  ]);

  const hub = new EventHub();
  const runner = new TaskRunner(plan.goal, { sink: hub.sink });
  await runner.heard('text');
  const snapshot = await runner.execute(compilePlan(plan, { toolGateway: gateway }));
  const artifact = hub.replay(snapshot.runId).find((event) => event.type === 'artifact.updated');
  assert.ok(artifact);
  assert.equal(typeof artifact.payload.preview, 'string');
  return artifact.payload.preview as string;
}

test('Drive preview shows useful file names without raw object dump', async () => {
  const preview = await previewFor('drive.files.search', {
    files: [
      { id: '1', name: 'Proyecto Janus' },
      { id: '2', name: 'Arquitectura Voice Gateway' },
    ],
  });

  assert.match(preview, /Drive: 2 resultados/);
  assert.match(preview, /Proyecto Janus/);
  assert.match(preview, /Arquitectura Voice Gateway/);
  assert.equal(preview.includes('"id"'), false);
});

test('Gmail preview shows subjects and compact senders but not snippets', async () => {
  const sensitiveSnippet = 'contenido completo que no debe aparecer en la tarjeta';
  const preview = await previewFor('gmail.messages.search', {
    messages: [
      {
        subject: 'Factura septiembre',
        from: 'Administración <billing@example.com>',
        snippet: sensitiveSnippet,
      },
    ],
  });

  assert.match(preview, /Factura septiembre/);
  assert.match(preview, /Administración/);
  assert.equal(preview.includes(sensitiveSnippet), false);
  assert.equal(preview.includes('billing@example.com'), false);
});

test('Calendar preview shows event titles and starts without descriptions', async () => {
  const sensitiveDescription = 'nota privada del evento que no debe salir en el resumen';
  const preview = await previewFor('calendar.events.list', {
    events: [
      {
        summary: 'Reunión Janus',
        start: { dateTime: '2026-09-14T09:00:00+02:00' },
        description: sensitiveDescription,
      },
    ],
  });

  assert.match(preview, /Calendar: 1 evento/);
  assert.match(preview, /Reunión Janus/);
  assert.equal(preview.includes(sensitiveDescription), false);
});

test('GitHub file preview does not echo source content', async () => {
  const source = 'const secretLookingButNotSecret = "do not echo source in preview";';
  const gateway = new DefaultToolGateway();
  const adapter: ToolAdapter = {
    name: 'github',
    capabilities: ['file.read'],
    execute: async () => ({
      ok: true,
      output: { path: 'src/index.ts', content: source },
    }),
  };
  gateway.register(adapter);

  const plan = createPlan('Leer archivo', [
    {
      id: 'read-file',
      kind: 'tool',
      label: 'Leer archivo',
      tool: 'github',
      action: 'file.read',
      input: { path: 'src/index.ts' },
      risk: 'none',
      reversible: true,
      requiresApproval: false,
    },
  ]);

  const hub = new EventHub();
  const runner = new TaskRunner(plan.goal, { sink: hub.sink });
  await runner.heard('text');
  const snapshot = await runner.execute(compilePlan(plan, { toolGateway: gateway }));
  const artifact = hub.replay(snapshot.runId).find((event) => event.type === 'artifact.updated');
  assert.ok(artifact);
  const preview = String(artifact.payload.preview ?? '');
  assert.match(preview, /src\/index\.ts leído/);
  assert.equal(preview.includes(source), false);
});
