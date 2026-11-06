import type { Db } from './db.ts';
import { conflict } from './errors.ts';

export interface ReserveLine {
  editionId: number;
  qty: number;
  digital: boolean;
}

/**
 * Stock reservations. The conditional UPDATE is atomic, so two buyers can never
 * reserve the same last copy (no oversell); callers run it inside db.tx so a
 * failed line rolls back the whole order.
 */
export class InventoryService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  reserve(orderId: string, lines: ReserveLine[]): void {
    for (const l of lines) {
      if (l.digital) continue;
      const r = this.db.run(
        'UPDATE stock SET reserved = reserved + ? WHERE edition_id = ? AND on_hand - reserved >= ?',
        l.qty,
        l.editionId,
        l.qty,
      );
      if (r.changes === 0) throw conflict('INSUFFICIENT_STOCK', 'One or more items are out of stock');
      this.db.run("INSERT INTO reservations (order_id, edition_id, qty, status) VALUES (?, ?, ?, 'ACTIVE')", orderId, l.editionId, l.qty);
    }
  }

  /** Payment succeeded: reserved units leave the shelf. */
  commit(orderId: string): void {
    for (const r of this.active(orderId, 'ACTIVE')) {
      this.db.run('UPDATE stock SET on_hand = on_hand - ?, reserved = reserved - ? WHERE edition_id = ?', r.qty, r.qty, r.edition_id);
      this.db.run("UPDATE reservations SET status = 'COMMITTED' WHERE id = ?", r.id);
    }
  }

  /** Order cancelled/expired/failed before payment: free the reservation. */
  release(orderId: string): void {
    for (const r of this.active(orderId, 'ACTIVE')) {
      this.db.run('UPDATE stock SET reserved = reserved - ? WHERE edition_id = ?', r.qty, r.edition_id);
      this.db.run("UPDATE reservations SET status = 'RELEASED' WHERE id = ?", r.id);
    }
  }

  /** Paid order cancelled before shipping: put committed units back. */
  restock(orderId: string): void {
    for (const r of this.active(orderId, 'COMMITTED')) {
      this.db.run('UPDATE stock SET on_hand = on_hand + ? WHERE edition_id = ?', r.qty, r.edition_id);
      this.db.run("UPDATE reservations SET status = 'RELEASED' WHERE id = ?", r.id);
    }
  }

  private active(orderId: string, status: string): { id: number; edition_id: number; qty: number }[] {
    return this.db.all('SELECT id, edition_id, qty FROM reservations WHERE order_id = ? AND status = ?', orderId, status);
  }
}
