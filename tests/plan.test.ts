import assert from 'node:assert/strict';
import test from 'node:test';
import { EventHub } from '../packages/core/src/event-hub.js';
import { TaskRunner } from '../packages/core/src/task-runner.js';
import { DefaultToolGateway } from '../packages/gateways/src/tool-gateway.js';
import type { ToolAdapter } from '../packages/gateways/src/contracts.js';
import { compilePlan } from '../packages/orchestrator/src/compile-plan.js';
import { createPlan, validatePlan } from '../packages/orchestrator/src/plan.js';

test('plan validation rejects irreversible work without approval and idempotency', () => {
  const plan = createPlan('Enviar un mensaje', [
    {
      id: 'send-message',
      kind: 'tool',
      label: 'Enviar mensaje',
      tool: 'messaging',
      action: 'send',
      input: { recipient: 'someone' },
      risk: 'high',
      reversible: false,
      requiresApproval: false,
    },
  ]);

  const validation = validatePlan(plan);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes('must require approval')));
  assert.ok(validation.errors.some((error) => error.includes('idempotency key')));
});

test('validated read-only plan compiles into observable tool execution', async () => {
  const adapter: ToolAdapter = {
    name: 'demo',
    capabilities: ['read'],
    execute: async (_request, onProgress) => {
      await onProgress({ phase: 'progress', message: 'Leyendo', percent: 50 });
      return { ok: true, output: { value: 42 } };
    },
  };
  const gateway = new DefaultToolGateway();
  gateway.register(adapter);

  const plan = createPlan('Leer dato', [
    {
      id: 'read-demo',
      kind: 'tool',
      label: 'Leer dato',
      tool: 'demo',
      action: 'read',
      input: { path: '/safe' },
      risk: 'none',
      reversible: true,
      requiresApproval: false,
    },
  ]);

  const validation = validatePlan(plan, {
    allowedTools: new Set(['demo']),
    allowedActions: new Map([['demo', new Set(['read'])]]),
  });
  assert.equal(validation.ok, true);

  const hub = new EventHub();
  const runner = new TaskRunner(plan.goal, { sink: hub.sink });
  await runner.heard('text');
  const snapshot = await runner.execute(compilePlan(plan, { toolGateway: gateway }));

  assert.equal(snapshot.status, 'completed');
  const types = hub.replay(snapshot.runId).map((event) => event.type);
  assert.ok(types.includes('tool.started'));
  assert.ok(types.includes('tool.progress'));
  assert.ok(types.includes('tool.completed'));
  assert.ok(types.includes('artifact.updated'));
});
