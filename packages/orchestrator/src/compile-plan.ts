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
        preview: summarizeResult(step, result),
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
  for (const key of ['url', 'path', 'repo', 'fileId', 'documentId', 'recipient', 'query', 'calendarId']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function summarizeResult(step: PlannedToolStep, result: ToolResult): string {
  const output = result.output ?? {};

  if (step.tool === 'github' && step.action === 'repo.get') {
    const fullName = stringValue(output.fullName) ?? `${stringValue(output.owner) ?? ''}/${stringValue(output.repo) ?? ''}`;
    const visibility = output.private === true ? 'privado' : 'público';
    const branch = stringValue(output.defaultBranch) ?? 'rama desconocida';
    return clip(`${fullName} · ${visibility} · rama ${branch}`);
  }

  if (step.tool === 'github' && step.action === 'contents.list') {
    const entries = recordArray(output.entries);
    const names = entries.slice(0, 6).map((entry) => stringValue(entry.name)).filter(Boolean);
    const path = stringValue(output.path) || 'raíz';
    return clip(`${entries.length} entradas en ${path}${names.length ? ` · ${names.join(' · ')}` : ''}`);
  }

  if (step.tool === 'github' && step.action === 'file.read') {
    const path = stringValue(output.path) ?? 'archivo';
    const content = stringValue(output.content) ?? '';
    return `${path} leído · ${content.length} caracteres.`;
  }

  if (step.tool === 'google-workspace' && step.action === 'drive.files.search') {
    const files = recordArray(output.files);
    if (files.length === 0) return 'Drive: no se encontraron archivos en esta consulta.';
    const names = files
      .slice(0, 6)
      .map((file) => stringValue(file.name) ?? 'sin nombre');
    return clip(`Drive: ${files.length} resultado${files.length === 1 ? '' : 's'} · ${names.join(' · ')}`);
  }

  if (step.tool === 'google-workspace' && step.action === 'gmail.messages.search') {
    const messages = recordArray(output.messages);
    if (messages.length === 0) return 'Gmail: no se encontraron mensajes en esta consulta.';
    const labels = messages.slice(0, 5).map((message) => {
      const subject = stringValue(message.subject) ?? '(sin asunto)';
      const from = compactSender(stringValue(message.from));
      return from ? `${subject} — ${from}` : subject;
    });
    return clip(`Gmail: ${messages.length} mensaje${messages.length === 1 ? '' : 's'} · ${labels.join(' · ')}`);
  }

  if (step.tool === 'google-workspace' && step.action === 'calendar.events.list') {
    const events = recordArray(output.events);
    if (events.length === 0) return 'Calendar: no hay eventos en la ventana consultada.';
    const labels = events.slice(0, 5).map((event) => {
      const summary = stringValue(event.summary) ?? '(sin título)';
      const start = isRecord(event.start) ? stringValue(event.start.dateTime) ?? stringValue(event.start.date) : undefined;
      return start ? `${summary} — ${shortDate(start)}` : summary;
    });
    return clip(`Calendar: ${events.length} evento${events.length === 1 ? '' : 's'} · ${labels.join(' · ')}`);
  }

  return result.externalReference
    ? clip(`${step.label} completado · ${result.externalReference}`)
    : `${step.label} completado.`;
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

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function compactSender(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return (match?.[1] ?? value).trim();
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function clip(value: string, max = 700): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
