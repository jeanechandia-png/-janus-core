export const PLAN_VERSION = 1 as const;

export type PlannedRisk = 'none' | 'low' | 'medium' | 'high';

export interface PlannedToolStep {
  id: string;
  kind: 'tool';
  label: string;
  tool: string;
  action: string;
  input: Record<string, unknown>;
  risk: PlannedRisk;
  reversible: boolean;
  requiresApproval: boolean;
  idempotencyKey?: string;
  resultMode?: 'summary' | 'full';
}

export type PlannedStep = PlannedToolStep;

export interface JanusPlan {
  version: typeof PLAN_VERSION;
  goal: string;
  steps: PlannedStep[];
  source: 'deterministic' | 'model' | 'user';
  createdAt: string;
}

export interface PlanValidationOptions {
  maxSteps?: number;
  allowedTools?: ReadonlySet<string>;
  allowedActions?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface PlanValidationResult {
  ok: boolean;
  errors: string[];
}

export function validatePlan(
  plan: JanusPlan,
  options: PlanValidationOptions = {},
): PlanValidationResult {
  const errors: string[] = [];
  const maxSteps = options.maxSteps ?? 50;

  if (plan.version !== PLAN_VERSION) errors.push(`Unsupported plan version: ${plan.version}`);
  if (!plan.goal.trim()) errors.push('Plan goal is required');
  if (plan.steps.length === 0) errors.push('Plan must contain at least one step');
  if (plan.steps.length > maxSteps) errors.push(`Plan exceeds maximum of ${maxSteps} steps`);

  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id.trim()) errors.push('Every step requires an id');
    if (ids.has(step.id)) errors.push(`Duplicate step id: ${step.id}`);
    ids.add(step.id);

    if (!step.label.trim()) errors.push(`Step ${step.id} requires a label`);
    if (!step.tool.trim()) errors.push(`Step ${step.id} requires a tool`);
    if (!step.action.trim()) errors.push(`Step ${step.id} requires an action`);

    if (options.allowedTools && !options.allowedTools.has(step.tool)) {
      errors.push(`Tool not allowed: ${step.tool}`);
    }

    const actions = options.allowedActions?.get(step.tool);
    if (actions && !actions.has(step.action)) {
      errors.push(`Action not allowed: ${step.tool}.${step.action}`);
    }

    if ((step.risk === 'high' || !step.reversible) && !step.requiresApproval) {
      errors.push(`Unsafe approval policy for ${step.id}: high-risk/irreversible action must require approval`);
    }

    if (step.action.match(/^(create|update|delete|send|publish|deploy|pay|purchase)/i) && !step.idempotencyKey) {
      errors.push(`Write-like action ${step.id} requires an idempotency key`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function createPlan(
  goal: string,
  steps: PlannedStep[],
  source: JanusPlan['source'] = 'deterministic',
): JanusPlan {
  return {
    version: PLAN_VERSION,
    goal,
    steps,
    source,
    createdAt: new Date().toISOString(),
  };
}
