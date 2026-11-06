import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

export type Param = SQLInputValue;

/**
 * Thin synchronous wrapper over node:sqlite. All statements are parameterized.
 * Transactions are synchronous on purpose: with a single connection and a
 * single-threaded runtime, a sync transaction can never interleave with another
 * request, which makes stock reservation trivially race-free.
 */
export class Db {
  raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as unknown as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as unknown as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      const sp = `sp${this.depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn();
        assertSync(r);
        this.raw.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.depth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const r = fn();
      assertSync(r);
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.raw.close();
  }
}

function assertSync(v: unknown): void {
  if (v && typeof (v as { then?: unknown }).then === 'function') {
    throw new Error('Db.tx callback must be synchronous');
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && e.message.includes('UNIQUE constraint failed');
}

export const nowIso = (): string => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','catalog_admin','order_admin','support','admin')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_books_category ON books(category);

CREATE TABLE IF NOT EXISTS editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  isbn13 TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK (format IN ('hardcover','paperback','ebook','audiobook')),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_editions_book ON editions(book_id);

CREATE TABLE IF NOT EXISTS stock (
  edition_id INTEGER PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
  on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (reserved <= on_hand)
);

CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(title, author, description);

CREATE TABLE IF NOT EXISTS cart_items (
  user_id TEXT NOT NULL REFERENCES users(id),
  edition_id INTEGER NOT NULL REFERENCES editions(id),
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 20),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, edition_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  percent_off INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','PACKED','SHIPPED','DELIVERED','CANCELLED','REFUNDED','FAILED')),
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  coupon_code TEXT,
  shipping_address_enc TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL REFERENCES orders(id),
  edition_id INTEGER NOT NULL REFERENCES editions(id),
  title TEXT NOT NULL,
  isbn13 TEXT NOT NULL,
  format TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (order_id, edition_id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  edition_id INTEGER NOT NULL REFERENCES editions(id),
  qty INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','COMMITTED','RELEASED'))
);
CREATE INDEX IF NOT EXISTS idx_reservations_order ON reservations(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  provider_ref TEXT NOT NULL UNIQUE,
  client_secret_enc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('REQUIRES_PAYMENT','CAPTURED','FAILED','NEEDS_REFUND','REFUNDED')),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','PACKED','SHIPPED','DELIVERED','CANCELLED')),
  tracking_number TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  user_id TEXT NOT NULL REFERENCES users(id),
  edition_id INTEGER NOT NULL REFERENCES editions(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, edition_id)
);

CREATE TABLE IF NOT EXISTS download_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  edition_id INTEGER NOT NULL REFERENCES editions(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (book_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);

-- Transactional outbox + idempotent-consumer bookkeeping
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  dead INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(processed_at, dead, id);

CREATE TABLE IF NOT EXISTS processed_events (
  consumer TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  PRIMARY KEY (consumer, event_id)
);
`;
