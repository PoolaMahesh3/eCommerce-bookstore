import type { Db } from './db.ts';
import { nowIso } from './db.ts';

export interface BusEvent<T = Record<string, unknown>> {
  id: number;
  topic: string;
  payload: T;
}
export type Handler = (e: BusEvent) => void;

const MAX_ATTEMPTS = 5;

/**
 * Transactional outbox: publish() inserts the event row; callers invoke it inside the
 * same db.tx as their state change (no dual-write). dispatch() delivers pending events
 * to subscribers; each (consumer,event) is recorded so redelivery is idempotent.
 * Swap dispatch() for a Kafka relay without touching producers.
 */
export class EventBus {
  private handlers = new Map<string, { consumer: string; fn: Handler }[]>();
  private draining = false;
  private db: Db;
  private log: { error: (o: object, m: string) => void };

  constructor(db: Db, log: { error: (o: object, m: string) => void }) {
    this.db = db;
    this.log = log;
  }

  subscribe(topic: string, consumer: string, fn: Handler): void {
    const list = this.handlers.get(topic) ?? [];
    list.push({ consumer, fn });
    this.handlers.set(topic, list);
  }

  publish(topic: string, payload: Record<string, unknown>): void {
    this.db.run('INSERT INTO outbox(topic,payload,created_at) VALUES(?,?,?)', topic, JSON.stringify(payload), nowIso());
  }

  /** Drain pending events until none remain. Re-entrancy safe. */
  dispatch(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let guard = 0; guard < 10_000; guard++) {
        const row = this.db.get<{ id: number; topic: string; payload: string; attempts: number }>(
          'SELECT id,topic,payload,attempts FROM outbox WHERE processed_at IS NULL AND dead = 0 ORDER BY id LIMIT 1',
        );
        if (!row) return;
        const event: BusEvent = { id: row.id, topic: row.topic, payload: JSON.parse(row.payload) as Record<string, unknown> };
        try {
          for (const h of this.handlers.get(row.topic) ?? []) {
            this.db.tx(() => {
              const seen = this.db.get('SELECT 1 AS x FROM processed_events WHERE consumer=? AND event_id=?', h.consumer, row.id);
              if (seen) return;
              h.fn(event);
              this.db.run('INSERT INTO processed_events(consumer,event_id) VALUES(?,?)', h.consumer, row.id);
            });
          }
          this.db.run('UPDATE outbox SET processed_at=? WHERE id=?', nowIso(), row.id);
        } catch (e) {
          const attempts = row.attempts + 1;
          this.log.error({ eventId: row.id, topic: row.topic, err: e instanceof Error ? e.message : 'unknown' }, 'event handler failed');
          this.db.run(
            'UPDATE outbox SET attempts=?, dead=?, last_error=? WHERE id=?',
            attempts,
            attempts >= MAX_ATTEMPTS ? 1 : 0,
            e instanceof Error ? e.message.slice(0, 500) : 'unknown',
            row.id,
          );
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
