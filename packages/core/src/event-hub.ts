import type { EventSink, JanusEvent } from './events.js';

export type EventSubscriber = (event: JanusEvent) => void;

export class EventHub {
  private readonly history: JanusEvent[] = [];
  private readonly subscribers = new Set<EventSubscriber>();
  private readonly maxHistory: number;

  constructor(maxHistory = 500) {
    this.maxHistory = maxHistory;
  }

  readonly sink: EventSink = async (event) => {
    this.appendToHistory(event);
    for (const subscriber of this.subscribers) subscriber(event);
  };

  hydrate(events: JanusEvent[]): void {
    const known = new Set(this.history.map((event) => event.id));
    for (const event of events) {
      if (!known.has(event.id)) {
        this.appendToHistory(event);
        known.add(event.id);
      }
    }
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  replay(runId?: string): JanusEvent[] {
    if (!runId) return [...this.history];
    return this.history.filter((event) => event.runId === runId);
  }

  private appendToHistory(event: JanusEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }
}
