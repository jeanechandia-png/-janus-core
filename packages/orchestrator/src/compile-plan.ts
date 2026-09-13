import type { JanusEventType } from '../../core/src/events.js';
import type { JanusStep } from '../../core/src/task-runner.js';
import type { ToolGateway, ToolProgress, ToolResult } from '../../gateways/src/contracts.js';
import type { JanusPlan, PlannedToolStep } from './plan.js';

export interface CompilePlanOptions {
  toolGateway: ToolGateway;
  maxResultPayloadChars?: number;
}

export function compilePlan(plan: JanusPlan, options: CompilePlanOptions): JanusStep[] {
  return plan.steps.map((step) => compileToolStep(step, options));
}

function compileToolStep(step: PlannedToolStep, options: CompilePlanOptions): JanusStep {
  return {
    id: step.id,
    label: step.label,
    run: async ({ emit, checkpoint, assertCanExecute }) => {
      await checkpoint();
      await assertCanExecute({
        id: step.id,
        label: step.label,
        tool: step.tool,
        target: describeTarget(step.input),
        risk: step.risk,
        reversible: step.reversible,
        requiresApproval: step.requiresApproval,
      });

      const result = await options.toolGateway.execute(
        {
          tool: step.tool,
          action: step.action,
          input: step.input,
          idempotencyKey: step.idempotencyKey,
        },
        async (progress: ToolProgress) => {
          await checkpoint();
          await emit(
            eventType(progress.phase),
            progress.message,
            {
              tool: step.tool,
              action: step.action,
              percent: progress.percent,
              ...(progress.data ?? {}),
            },
            'tool',
          );
        },
      );

      if (!result.ok) {
        throw new Error(result.error ?? `${step.tool}.${step.action} failed`);
      }

      await emit('artifact.updated', `${step.label} — resultado disponible`, {
        tool: step.tool,
        action: step.action,
        result: compactResult(result, options.maxResultPayloadChars ?? 12_000),
      }, 'tool');
    },
  };
}

function eventType(phase: ToolProgress['phase']): JanusEventType {
  if (phase === 'started') return 'tool.started';
  if (phase === 'completed') return 'tool.completed';
  return 'tool.progress';
}

function describeTarget(input: Record<string, unknown>): string | undefined {
  for (const key of ['url', 'path', 'repo', 'fileId', 'documentId', 'recipient']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function compactResult(result: ToolResult, maxChars: number): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    ok: result.ok,
    externalReference: result.externalReference,
  };
  if (!result.output) return safe;

  const serialized = JSON.stringify(result.output);
  if (serialized.length <= maxChars) {
    safe.output = result.output;
    return safe;
  }

  safe.outputPreview = serialized.slice(0, maxChars);
  safe.truncated = true;
  safe.originalChars = serialized.length;
  return safe;
}
