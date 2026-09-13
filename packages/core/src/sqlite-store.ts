import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventSink, JanusEvent, RunSnapshot } from './events.js';

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  readonly eventSink: EventSink = async (event) => {
    this.appendEvent(event);
  };

  appendEvent(event: JanusEvent): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO events
        (id, run_id, seq, type, at, source, summary, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.runId,
      event.seq,
      event.type,
      event.at,
      event.source,
      event.summary,
      JSON.stringify(event.payload ?? {}),
    );
  }

  upsertRun(snapshot: RunSnapshot): void {
    this.db.prepare(`
      INSERT INTO runs
        (id, goal, status, current_step, last_event_seq, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        goal = excluded.goal,
        status = excluded.status,
        current_step = excluded.current_step,
        last_event_seq = excluded.last_event_seq,
        updated_at = excluded.updated_at
    `).run(
      snapshot.runId,
      snapshot.goal,
      snapshot.status,
      snapshot.currentStep ?? null,
      snapshot.lastEventSeq,
      snapshot.startedAt,
      snapshot.updatedAt,
    );
  }

  getRun(runId: string): RunSnapshot | null {
    const row = this.db.prepare(`
      SELECT id, goal, status, current_step, last_event_seq, started_at, updated_at
      FROM runs WHERE id = ?
    `).get(runId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      runId: String(row.id),
      goal: String(row.goal),
      status: String(row.status) as RunSnapshot['status'],
      currentStep: row.current_step == null ? undefined : String(row.current_step),
      lastEventSeq: Number(row.last_event_seq),
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
    };
  }

  listEvents(runId?: string, limit = 500): JanusEvent[] {
    const rows = runId
      ? this.db.prepare(`
          SELECT id, run_id, seq, type, at, source, summary, payload_json
          FROM events WHERE run_id = ? ORDER BY seq ASC LIMIT ?
        `).all(runId, limit)
      : this.db.prepare(`
          SELECT id, run_id, seq, type, at, source, summary, payload_json
          FROM events ORDER BY rowid DESC LIMIT ?
        `).all(limit).reverse();

    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      seq: Number(row.seq),
      type: String(row.type) as JanusEvent['type'],
      at: String(row.at),
      source: String(row.source) as JanusEvent['source'],
      summary: String(row.summary),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }

  markInterruptedRuns(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE runs
      SET status = 'blocked', updated_at = ?
      WHERE status IN ('heard', 'running', 'waiting_approval')
    `).run(now);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step TEXT,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_run_seq
      ON events(run_id, seq);
    `);
  }
}

export function combineEventSinks(...sinks: EventSink[]): EventSink {
  return async (event) => {
    for (const sink of sinks) await sink(event);
  };
}
