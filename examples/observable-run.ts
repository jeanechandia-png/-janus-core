import { EventHub } from '../packages/core/src/event-hub.js';
import { TaskRunner } from '../packages/core/src/task-runner.js';

const hub = new EventHub();
hub.subscribe((event) => {
  const time = new Date(event.at).toLocaleTimeString();
  console.log(`${time}  ${event.type.padEnd(22)} ${event.summary}`);
});

const runner = new TaskRunner('Investigar un tema y mantener actividad visible', {
  sink: hub.sink,
  approvalHandler: async (action) => ({ approved: action.risk !== 'high' }),
});

await runner.heard('voice');
await runner.execute([
  {
    id: 'research',
    label: 'Investigar fuentes',
    run: async ({ emit }) => {
      await emit('tool.started', 'Buscando fuentes oficiales', { tool: 'web' }, 'tool');
      await emit('tool.progress', 'Fuente primaria encontrada', { percent: 50 }, 'tool');
      await emit('tool.completed', 'Fuentes verificadas', { percent: 100 }, 'tool');
    },
  },
  {
    id: 'deliver',
    label: 'Entregar resultado',
    run: async ({ emit }) => {
      await emit('artifact.updated', 'Respuesta preparada', { artifact: 'answer' });
    },
  },
]);
