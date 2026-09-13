import assert from 'node:assert/strict';
import test from 'node:test';
import { EventHub } from '../packages/core/src/event-hub.js';
import { TaskRunner } from '../packages/core/src/task-runner.js';
import type { JanusEventType } from '../packages/core/src/events.js';

test('voice run stays observable from heard to completed', async () => {
  const hub = new EventHub();
  const runner = new TaskRunner('Investigar y ejecutar', { sink: hub.sink });

  await runner.heard('voice');
  const snapshot = await runner.execute([
    {
      id: 'research',
      label: 'Investigar',
      run: async ({ emit }) => {
        await emit('tool.started', 'Abriendo fuente', { tool: 'web' }, 'tool');
        await emit('tool.progress', 'Leyendo resultados', { percent: 50 }, 'tool');
        await emit('tool.completed', 'Fuente revisada', {}, 'tool');
      },
    },
    {
      id: 'deliver',
      label: 'Preparar resultado',
      run: async ({ emit }) => {
        await emit('artifact.updated', 'Resultado listo', { path: 'result.md' });
      },
    },
  ]);

  assert.equal(snapshot.status, 'completed');
  const types = hub.replay(snapshot.runId).map((event) => event.type);
  const expected: JanusEventType[] = [
    'run.heard',
    'run.started',
    'tool.started',
    'tool.progress',
    'tool.completed',
    'artifact.updated',
    'run.completed',
  ];
  for (const type of expected) {
    assert.ok(types.includes(type), `missing ${type}`);
  }
});

test('high-risk action blocks without an approval handler', async () => {
  const hub = new EventHub();
  const runner = new TaskRunner('Acción externa', { sink: hub.sink });

  await runner.heard('text');
  const snapshot = await runner.execute([
    {
      id: 'external',
      label: 'Acción externa',
      run: async ({ assertCanExecute }) => {
        await assertCanExecute({
          id: 'send',
          label: 'Enviar mensaje externo',
          tool: 'messaging',
          risk: 'high',
          reversible: false,
          requiresApproval: true,
        });
      },
    },
  ]);

  assert.equal(snapshot.status, 'blocked');
  const types = hub.replay(snapshot.runId).map((event) => event.type);
  assert.ok(types.includes('approval.required'));
  assert.ok(types.includes('run.blocked'));
});
