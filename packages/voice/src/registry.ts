import {
  VoiceSessionController,
  type VoiceRunController,
  type VoiceSessionSnapshot,
} from './session.js';

export type VoiceRunControllerFactory = (sessionId: string) => VoiceRunController;

export class VoiceSessionRegistry {
  private readonly sessions = new Map<string, VoiceSessionController>();
  private readonly runControllerFactory: VoiceRunControllerFactory;

  constructor(runControllerFactory: VoiceRunControllerFactory) {
    this.runControllerFactory = runControllerFactory;
  }

  get(sessionId: string): VoiceSessionController {
    const cleanId = sessionId.trim();
    if (!cleanId) throw new Error('voice session id is required');

    const existing = this.sessions.get(cleanId);
    if (existing) return existing;

    const session = new VoiceSessionController({
      sessionId: cleanId,
      runs: this.runControllerFactory(cleanId),
    });
    this.sessions.set(cleanId, session);
    return session;
  }

  snapshots(): VoiceSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  sessionIdForRun(runId: string): string | undefined {
    for (const session of this.sessions.values()) {
      const snapshot = session.snapshot();
      if (snapshot.activeRunId === runId) return snapshot.sessionId;
    }
    return undefined;
  }

  runCompleted(runId: string): void {
    for (const session of this.sessions.values()) session.runCompleted(runId);
  }

  runBlocked(runId: string): void {
    for (const session of this.sessions.values()) session.runBlocked(runId);
  }
}
