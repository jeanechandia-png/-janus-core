import type { ModelGateway, ModelMessage } from '../../gateways/src/contracts.js';
import {
  createPlan,
  validatePlan,
  type JanusPlan,
  type PlanValidationOptions,
  type PlannedRisk,
  type PlannedToolStep,
} from './plan.js';

export interface ModelPlannerOptions extends PlanValidationOptions {
  modelGateway: ModelGateway;
  toolCatalog: Record<string, readonly string[]>;
  context?: Record<string, unknown>;
  maxSteps?: number;
}

export interface ModelPlanResult {
  plan: JanusPlan | null;
  provider?: string;
  model?: string;
  error?: string;
}

export async function planWithModel(
  command: string,
  options: ModelPlannerOptions,
): Promise<ModelPlanResult> {
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: plannerSystemPrompt(options.toolCatalog, options.maxSteps ?? 20),
    },
    {
      role: 'user',
      content: JSON.stringify({
        command,
        context: options.context ?? {},
      }),
    },
  ];

  let response;
  try {
    response = await options.modelGateway.complete({
      messages,
      temperature: 0,
      responseFormat: 'json',
    });
  } catch (error) {
    return {
      plan: null,
      error: `Model Gateway failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let plan: JanusPlan;
  try {
    plan = parseModelPlan(response.text, command, options.maxSteps ?? 20);
  } catch (error) {
    return {
      plan: null,
      provider: response.provider,
      model: response.model,
      error: `Model plan rejected before validation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const validation = validatePlan(plan, {
    maxSteps: options.maxSteps ?? 20,
    allowedTools: options.allowedTools,
    allowedActions: options.allowedActions,
  });
  if (!validation.ok) {
    return {
      plan: null,
      provider: response.provider,
      model: response.model,
      error: `Model plan rejected by Janus Core: ${validation.errors.join('; ')}`,
    };
  }

  return {
    plan,
    provider: response.provider,
    model: response.model,
  };
}

export function parseModelPlan(text: string, fallbackGoal: string, maxSteps = 20): JanusPlan {
  const json = extractJsonObject(text);
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error('model response is not a JSON object');

  const rawSteps = parsed.steps;
  if (!Array.isArray(rawSteps)) throw new Error('model response must contain a steps array');
  if (rawSteps.length === 0) throw new Error('model plan has no steps');
  if (rawSteps.length > maxSteps) throw new Error(`model plan exceeds ${maxSteps} steps`);

  const steps = rawSteps.map((step, index) => parseToolStep(step, index));
  const goal = stringValue(parsed.goal) ?? fallbackGoal.trim();
  return createPlan(goal || fallbackGoal, steps, 'model');
}

function parseToolStep(value: unknown, index: number): PlannedToolStep {
  if (!isRecord(value)) throw new Error(`step ${index + 1} is not an object`);

  const id = stringValue(value.id);
  const label = stringValue(value.label);
  const tool = stringValue(value.tool);
  const action = stringValue(value.action);
  const risk = riskValue(value.risk);

  if (!id) throw new Error(`step ${index + 1} is missing id`);
  if (!label) throw new Error(`step ${id} is missing label`);
  if (!tool) throw new Error(`step ${id} is missing tool`);
  if (!action) throw new Error(`step ${id} is missing action`);
  if (!risk) throw new Error(`step ${id} has invalid risk`);
  if (!isRecord(value.input)) throw new Error(`step ${id} input must be an object`);
  if (typeof value.reversible !== 'boolean') throw new Error(`step ${id} reversible must be boolean`);
  if (typeof value.requiresApproval !== 'boolean') {
    throw new Error(`step ${id} requiresApproval must be boolean`);
  }

  const idempotencyKey = stringValue(value.idempotencyKey);
  const resultMode = value.resultMode === 'full' ? 'full' : 'summary';

  return {
    id,
    kind: 'tool',
    label,
    tool,
    action,
    input: value.input,
    risk,
    reversible: value.reversible,
    requiresApproval: value.requiresApproval,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    resultMode,
  };
}

function plannerSystemPrompt(toolCatalog: Record<string, readonly string[]>, maxSteps: number): string {
  return [
    'You are a replaceable planning adapter for JANUS CORE.',
    'You are NOT the authority and you must never claim that an action was executed.',
    'Return JSON only. No markdown, explanations, or code fences.',
    `Use at most ${maxSteps} steps.`,
    'Every step must be a tool step with these fields:',
    'id, label, tool, action, input, risk, reversible, requiresApproval, optional idempotencyKey, optional resultMode.',
    "risk must be one of: none, low, medium, high.",
    'Use only the exact tools/actions in the catalog below.',
    'Prefer read-only actions when they can satisfy the request.',
    'Any high-risk or irreversible action MUST set requiresApproval=true.',
    'Any write-like action (create/update/delete/send/publish/deploy/pay/purchase) MUST include a stable idempotencyKey.',
    'Do not place credentials, tokens, passwords, or secrets in plan inputs.',
    'If no allowed tool can satisfy the request, return {"goal":"...","steps":[]} rather than inventing a capability.',
    `Tool catalog: ${JSON.stringify(toolCatalog)}`,
    'Expected shape: {"goal":"string","steps":[{"id":"string","label":"string","tool":"string","action":"string","input":{},"risk":"none","reversible":true,"requiresApproval":false,"resultMode":"summary"}]}',
  ].join('\n');
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('empty model response');

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  return unfenced.slice(start, end + 1);
}

function riskValue(value: unknown): PlannedRisk | undefined {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high'
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
