import { randomUUID } from 'node:crypto';
import type {
  EventSink,
  JanusEvent,
  JanusEventType,
  ObservableAction,
  RunSnapshot,
  RunStatus,
} from './events.js';

export interface StepContext {
  runId: string;
  emit: (
    type: JanusEventType,
    summary: string,
    payload?: Record<string, unknown>,
    source?: JanusEvent['source'],
  ) => Promise<void>;
  assertCanExecute: (action: ObservableAction) => Promise<void>;
}

export interface JanusStep {
  id: string;
  label: string;
  run: (context: StepContext) => Promise<void>;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export type ApprovalHandler = (
  action: ObservableAction,
  snapshot: RunSnapshot,
) => Promise<ApprovalDecision>;

export interface TaskRunnerOptions {
  sink: EventSink;
  approvalHandler?: ApprovalHandler;
  now?: () => Date;
}

export class TaskRunner {
  private seq = 0;
  private paused = false;
  private status: RunStatus = 'heard';
  private currentStep?: string;
  private readonly runId = `run_${randomUUID()}`;
  private readonly startedAt: string;
  private updatedAt: string;

  constructor(
    private readonly goal: string,
    private readonly options: TaskRunnerOptions,
  ) {
    const now = this.now();
    this.startedAt = now;
    this.updatedAt = now;
  }

  snapshot(): RunSnapshot {
    return {
      runId: this.runId,
      goal: this.goal,
      status: this.status,
      currentStep: this.currentStep,
      lastEventSeq: this.seq,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
    };
  }

  async heard(inputMode: 'voice' | 'text'): Promise<void> {
    this.status = 'heard';
    await this.emit('run.heard', 'Solicitud recibida', { inputMode });
  }

  async execute(steps: JanusStep[]): Promise<RunSnapshot> {
    this.status = 'running';
    await this.emit('run.started', 'Janus comenzó a ejecutar', {
      goal: this.goal,
      stepCount: steps.length,
    });

    try {
      for (const step of steps) {
        await this.waitWhilePaused();
        this.currentStep = step.id;
        await this.emit('run.step.started', step.label, {
          stepId: step.id,
        });

        await step.run({
          runId: this.runId,
          emit: (type, summary, payload = {}, source = 'core') =>
            this.emit(type, summary, payload, source),
          assertCanExecute: (action) => this.assertCanExecute(action),
        });

        await this.emit('run.step.completed', `${step.label} — terminado`, {
          stepId: step.id,
        });
      }

      this.currentStep = undefined;
      this.status = 'completed';
      await this.emit('run.completed', 'Objetivo completado', {
        goal: this.goal,
      });
      return this.snapshot();
    } catch (error) {
      if (this.status === 'blocked' || this.status === 'paused') {
        return this.snapshot();
      }
      this.status = 'failed';
      await this.emit('run.failed', 'La ejecución encontró un error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async pause(reason = 'Pausa solicitada por el usuario'): Promise<void> {
    this.paused = true;
    this.status = 'paused';
    await this.emit('run.paused', reason);
  }

  async resume(): Promise<void> {
    this.paused = false;
    this.status = 'running';
    await this.emit('run.resumed', 'Ejecución reanudada');
  }

  async block(reason: string, details: Record<string, unknown> = {}): Promise<void> {
    this.status = 'blocked';
    await this.emit('run.blocked', reason, details);
  }

  private async assertCanExecute(action: ObservableAction): Promise<void> {
    if (!action.requiresApproval) return;

    this.status = 'waiting_approval';
    await this.emit('approval.required', `Aprobación requerida: ${action.label}`, {
      action,
    });

    if (!this.options.approvalHandler) {
      await this.block('No hay manejador de aprobación disponible', { action });
      throw new Error('Approval handler unavailable');
    }

    const decision = await this.options.approvalHandler(action, this.snapshot());
    if (!decision.approved) {
      await this.block(decision.reason ?? 'Acción no aprobada', { action });
      throw new Error(decision.reason ?? 'Action not approved');
    }

    this.status = 'running';
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async emit(
    type: JanusEventType,
    summary: string,
    payload: Record<string, unknown> = {},
    source: JanusEvent['source'] = 'core',
  ): Promise<void> {
    this.seq += 1;
    this.updatedAt = this.now();
    await this.options.sink({
      id: `evt_${randomUUID()}`,
      runId: this.runId,
      seq: this.seq,
      type,
      at: this.updatedAt,
      source,
      summary,
      payload,
    });
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
