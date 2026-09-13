export type RunStatus =
  | 'heard'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'failed';

export type JanusEventType =
  | 'run.heard'
  | 'run.started'
  | 'run.step.started'
  | 'run.step.completed'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.completed'
  | 'artifact.updated'
  | 'approval.required'
  | 'run.blocked'
  | 'run.paused'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed';

export interface JanusEvent<TPayload = Record<string, unknown>> {
  id: string;
  runId: string;
  seq: number;
  type: JanusEventType;
  at: string;
  source: 'core' | 'model' | 'voice' | 'tool' | 'ui' | 'system';
  summary: string;
  payload: TPayload;
}

export interface ObservableAction {
  id: string;
  label: string;
  tool?: string;
  target?: string;
  risk: 'none' | 'low' | 'medium' | 'high';
  reversible: boolean;
  requiresApproval: boolean;
}

export interface RunSnapshot {
  runId: string;
  goal: string;
  status: RunStatus;
  currentStep?: string;
  lastEventSeq: number;
  startedAt: string;
  updatedAt: string;
}

export type EventSink = (event: JanusEvent) => void | Promise<void>;

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
