import type { FastifyInstance } from 'fastify';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import type { EventBus } from './events.ts';
import { requireUser } from './auth.ts';
import { randomToken } from './crypto.ts';
import { notFound } from './errors.ts';
import { randomUUID } from 'node:crypto';
import { decodeCursor, encodeCursor, intParam, pageLimit, queryInt, queryStr, asObj } from './validate.ts';
import type { Obj } from './validate.ts';

/**
 * Event-driven consumers: fulfillment (shipments), digital delivery (entitlements)
 * and notifications. Each is idempotent via the bus' processed_events bookkeeping
 * plus natural keys (INSERT OR IGNORE).
 */
export function registerFulfillment(bus: EventBus, db: Db): void {
  bus.subscribe('order.paid', 'fulfillment', (e) => {
    const orderId = String(e.payload.orderId);
    const physical = db.get("SELECT 1 AS x FROM order_items WHERE order_id = ? AND format NOT IN ('ebook','audiobook')", orderId);
    const now = nowIso();
    if (physical) {
      db.run("INSERT OR IGNORE INTO shipments (id, order_id, status, created_at, updated_at) VALUES (?, ?, 'PENDING', ?, ?)", randomUUID(), orderId, now, now);
    } else {
      // Digital-only orders have nothing to pack or ship: complete immediately.
      db.run("UPDATE orders SET status = 'DELIVERED', updated_at = ? WHERE id = ? AND status = 'PAID'", now, orderId);
    }
  });

  bus.subscribe('order.paid', 'digital-delivery', (e) => {
    const orderId = String(e.payload.orderId);
    const userId = String(e.payload.userId);
    const items = db.all<{ edition_id: number }>("SELECT edition_id FROM order_items WHERE order_id = ? AND format IN ('ebook','audiobook')", orderId);
    for (const i of items) {
      db.run('INSERT OR IGNORE INTO entitlements (user_id, edition_id, order_id, granted_at) VALUES (?, ?, ?, ?)', userId, i.edition_id, orderId, nowIso());
    }
  });

  for (const topic of ['order.paid', 'order.failed', 'order.cancelled', 'order.refunded', 'order.status_changed']) {
    bus.subscribe(topic, 'notifications', (e) => {
      const userId = e.payload.userId;
      if (typeof userId !== 'string') return;
      // Minimal payload: no PII. A real sender would render a template and call an email/SMS provider.
      db.run(
        'INSERT INTO notifications (user_id, kind, payload, created_at) VALUES (?, ?, ?, ?)',
        userId,
        topic,
        JSON.stringify({ orderId: e.payload.orderId, status: e.payload.status ?? null }),
        nowIso(),
      );
    });
  }
}

export function registerDigitalAndNotifications(app: FastifyInstance, db: Db, config: Config): void {
  // Library of purchased digital editions.
  app.get('/v1/library', async (req) => {
    const u = requireUser(req);
    return {
      items: db.all<Obj>(
        `SELECT en.edition_id AS editionId, e.isbn13, e.format, b.title, en.granted_at AS grantedAt
           FROM entitlements en JOIN editions e ON e.id = en.edition_id JOIN books b ON b.id = e.book_id
          WHERE en.user_id = ? ORDER BY en.granted_at DESC`,
        u.id,
      ),
    };
  });

  // Issue a short-lived, single-user download link for an owned edition.
  app.post('/v1/library/:editionId/download-link', async (req, reply) => {
    const u = requireUser(req);
    const editionId = intParam((req.params as Obj).editionId, 'editionId');
    if (!db.get('SELECT 1 AS x FROM entitlements WHERE user_id = ? AND edition_id = ?', u.id, editionId)) throw notFound('Entitlement');
    const id = randomToken(32);
    const expires = new Date(Date.now() + config.downloadLinkTtlSec * 1000).toISOString();
    db.run('INSERT INTO download_links (id, user_id, edition_id, expires_at) VALUES (?, ?, ?, ?)', id, u.id, editionId, expires);
    return reply.code(201).send({ url: `/v1/downloads/${id}`, expiresAt: expires });
  });

  // Redeem. Object storage is stubbed: a real deployment returns a pre-signed object-store URL here.
  app.get('/v1/downloads/:token', async (req, reply) => {
    const u = requireUser(req);
    const token = (req.params as Obj).token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound('Download');
    const link = db.get<{ edition_id: number; expires_at: string }>('SELECT edition_id, expires_at FROM download_links WHERE id = ? AND user_id = ?', token, u.id);
    if (!link || link.expires_at <= nowIso()) throw notFound('Download');
    db.run('UPDATE download_links SET used_at = COALESCE(used_at, ?) WHERE id = ?', nowIso(), token);
    const ed = db.get<{ isbn13: string; format: string }>('SELECT isbn13, format FROM editions WHERE id = ?', link.edition_id);
    reply.header('Cache-Control', 'no-store');
    return { editionId: link.edition_id, isbn13: ed?.isbn13, format: ed?.format, storage: 'stub' };
  });

  app.get('/v1/notifications', async (req) => {
    const u = requireUser(req);
    const q = asObj(req.query, 'Query');
    const limit = pageLimit(q);
    const cur = decodeCursor(queryStr(q, 'cursor', 100));
    const before = cur && typeof cur.i === 'number' ? cur.i : Number.MAX_SAFE_INTEGER;
    const rows = db.all<{ id: number; kind: string; payload: string; created_at: string }>(
      'SELECT id, kind, payload, created_at FROM notifications WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
      u.id,
      before,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as unknown, createdAt: r.created_at })),
      nextCursor: rows.length > limit && last ? encodeCursor({ i: last.id }) : null,
    };
  });
}

export { queryInt };
