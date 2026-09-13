import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelGateway, ModelRequest, ModelResponse } from '../packages/gateways/src/contracts.js';
import { planWithModel } from '../packages/orchestrator/src/model-planner.js';

class StubModel implements ModelGateway {
  constructor(private readonly text: string) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    return {
      text: this.text,
      model: 'stub-model',
      provider: 'stub-provider',
    };
  }
}

const allowedTools = new Set(['google-workspace']);
const allowedActions = new Map([
  ['google-workspace', new Set(['drive.files.search', 'gmail.messages.search', 'calendar.events.list'])],
]);
const toolCatalog = {
  'google-workspace': ['drive.files.search', 'gmail.messages.search', 'calendar.events.list'],
};

test('accepts a model plan only after Janus Core validation', async () => {
  const modelGateway = new StubModel(JSON.stringify({
    goal: 'Buscar documentos Janus',
    steps: [
      {
        id: 'drive-search',
        label: 'Buscar Janus en Drive',
        tool: 'google-workspace',
        action: 'drive.files.search',
        input: { query: 'Janus' },
        risk: 'none',
        reversible: true,
        requiresApproval: false,
      },
    ],
  }));

  const result = await planWithModel('busca documentos de Janus', {
    modelGateway,
    toolCatalog,
    allowedTools,
    allowedActions,
  });

  assert.ok(result.plan);
  assert.equal(result.plan.source, 'model');
  assert.equal(result.plan.steps[0]?.action, 'drive.files.search');
  assert.equal(result.provider, 'stub-provider');
});

test('rejects a model that invents a tool outside the allowlist', async () => {
  const modelGateway = new StubModel(JSON.stringify({
    goal: 'Inventar capacidad',
    steps: [
      {
        id: 'unknown',
        label: 'Hacer algo no autorizado',
        tool: 'magic-admin',
        action: 'everything.do',
        input: {},
        risk: 'none',
        reversible: true,
        requiresApproval: false,
      },
    ],
  }));

  const result = await planWithModel('hazlo', {
    modelGateway,
    toolCatalog,
    allowedTools,
    allowedActions,
  });

  assert.equal(result.plan, null);
  assert.match(result.error ?? '', /Tool not allowed|Action not allowed/);
});

test('rejects unsafe model-authored writes even if the tool were otherwise allowed', async () => {
  const modelGateway = new StubModel(JSON.stringify({
    goal: 'Enviar correo',
    steps: [
      {
        id: 'send-mail',
        label: 'Enviar correo',
        tool: 'google-workspace',
        action: 'gmail.messages.send',
        input: { to: 'example@example.com' },
        risk: 'high',
        reversible: false,
        requiresApproval: false,
      },
    ],
  }));

  const result = await planWithModel('envía un correo', {
    modelGateway,
    toolCatalog: { 'google-workspace': ['gmail.messages.send'] },
    allowedTools,
    allowedActions: new Map([
      ['google-workspace', new Set(['gmail.messages.send'])],
    ]),
  });

  assert.equal(result.plan, null);
  assert.match(result.error ?? '', /Unsafe approval policy/);
  assert.match(result.error ?? '', /idempotency/i);
});

test('parses fenced JSON but rebuilds plan ownership as model source', async () => {
  const modelGateway = new StubModel(`\n\`\`\`json\n${JSON.stringify({
    source: 'user',
    createdAt: '1900-01-01T00:00:00.000Z',
    goal: 'Agenda',
    steps: [
      {
        id: 'calendar',
        label: 'Agenda',
        tool: 'google-workspace',
        action: 'calendar.events.list',
        input: {},
        risk: 'none',
        reversible: true,
        requiresApproval: false,
      },
    ],
  })}\n\`\`\``);

  const result = await planWithModel('agenda', {
    modelGateway,
    toolCatalog,
    allowedTools,
    allowedActions,
  });

  assert.ok(result.plan);
  assert.equal(result.plan.source, 'model');
  assert.notEqual(result.plan.createdAt, '1900-01-01T00:00:00.000Z');
});
