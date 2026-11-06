import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import type { EventBus } from './events.ts';
import type { PricingService } from './cart.ts';
import type { InventoryService } from './inventory.ts';
import type { PaymentService } from './payments.ts';
import { requireRole, requireUser } from './auth.ts';
import { decrypt, encrypt, sha256Hex } from './crypto.ts';
import { AppError, badRequest, conflict, notFound } from './errors.ts';
import { isDigital } from './catalog.ts';
import {
  allowKeys,
  asObj,
  decodeCursor,
  encodeCursor,
  optStr,
  pageLimit,
  queryStr,
  reqEnum,
  reqStr,
  uuidParam,
} from './validate.ts';
import type { Obj } from './validate.ts';

interface OrderRow {
  id: string;
  user_id: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  currency: string;
  coupon_code: string | null;
  shipping_address_enc: string | null;
  request_hash: string;
  created_at: string;
  updated_at: string;
}

interface Logger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const STATUSES = ['PENDING', 'PAID', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'FAILED'] as const;
const NEXT: Record<string, string> = { PAID: 'PACKED', PACKED: 'SHIPPED', SHIPPED: 'DELIVERED' };

function parseAddress(v: unknown): Obj {
  const a = asObj(v, 'shippingAddress');
  allowKeys(a, ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country']);
  const country = reqStr(a, 'country', 2, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw badRequest('INVALID_INPUT', 'country must be an ISO 3166 alpha-2 code');
  return {
    name: reqStr(a, 'name', 1, 100),
    line1: reqStr(a, 'line1', 1, 200),
    line2: optStr(a, 'line2', 1, 200) ?? null,
    city: reqStr(a, 'city', 1, 100),
    region: optStr(a, 'region', 1, 100) ?? null,
    postalCode: reqStr(a, 'postalCode', 2, 20),
    country,
  };
}

export class OrderService {
  private config: Config;
  private db: Db;
  private bus: EventBus;
  private pricing: PricingService;
  private inventory: InventoryService;
  private payments: PaymentService;
  private log: Logger;

  constructor(config: Config, db: Db, bus: EventBus, pricing: PricingService, inventory: InventoryService, payments: PaymentService, log: Logger) {
    this.config = config;
    this.db = db;
    this.bus = bus;
    this.pricing = pricing;
    this.inventory = inventory;
    this.payments = payments;
    this.log = log;
    this.subscribe();
  }

  /** Saga steps driven by payment events (choreography after the orchestrated reserve + intent). */
  private subscribe(): void {
    this.bus.subscribe('payment.captured', 'orders', (e) => {
      const orderId = String(e.payload.orderId);
      const o = this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', orderId);
      if (!o) return;
      if (o.status === 'PENDING') {
        this.inventory.commit(orderId);
        this.setStatus(orderId, 'PAID');
        this.bus.publish('order.paid', { orderId, userId: o.user_id });
      } else if (o.status === 'CANCELLED' || o.status === 'FAILED') {
        // Money arrived for an order we already gave up on: compensate with a refund.
        this.db.run("UPDATE payments SET status = 'NEEDS_REFUND', updated_at = ? WHERE order_id = ?", nowIso(), orderId);
        this.log.warn({ event: 'late_payment_refund', orderId }, 'payment captured after order closed; refund queued');
      }
    });
    this.bus.subscribe('payment.failed', 'orders', (e) => {
      const orderId = String(e.payload.orderId);
      const o = this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', orderId);
      if (o?.status !== 'PENDING') return;
      this.inventory.release(orderId);
      this.setStatus(orderId, 'FAILED');
      this.bus.publish('order.failed', { orderId, userId: o.user_id });
    });
  }

  private setStatus(orderId: string, status: string): void {
    this.db.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), orderId);
  }

  async checkout(userId: string, idempotencyKey: string, body: Obj): Promise<{ order: Obj; created: boolean }> {
    allowKeys(body, ['shippingAddress', 'couponCode']);
    const couponCode = optStr(body, 'couponCode', 1, 40);
    const address = body.shippingAddress === undefined ? undefined : parseAddress(body.shippingAddress);
    const requestHash = sha256Hex(JSON.stringify({ couponCode: couponCode?.toUpperCase() ?? null, address: address ?? null }));

    // Idempotent replay (no await between this lookup and the reserving transaction => no race).
    const prior = this.db.get<OrderRow>('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?', userId, idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash) {
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
      }
      const hasPayment = this.db.get('SELECT 1 AS x FROM payments WHERE order_id = ?', prior.id);
      if (!hasPayment && prior.status === 'PENDING') throw conflict('IN_PROGRESS', 'Checkout is still in progress; retry shortly');
      return { order: this.view(prior, true), created: false };
    }

    const quote = this.pricing.quoteCart(userId, couponCode);
    if (quote.lines.length === 0) throw badRequest('EMPTY_CART', 'Cart is empty');
    const needsShipping = quote.lines.some((l) => !isDigital(l.format));
    if (needsShipping && !address) throw badRequest('ADDRESS_REQUIRED', 'shippingAddress is required for physical items');
    for (const l of quote.lines) {
      if (isDigital(l.format) && this.db.get('SELECT 1 AS x FROM entitlements WHERE user_id = ? AND edition_id = ?', userId, l.editionId)) {
        throw conflict('ALREADY_OWNED', `You already own the digital edition of "${l.title}"`);
      }
    }

    const orderId = randomUUID();
    const now = nowIso();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO orders (id, user_id, status, subtotal_cents, discount_cents, total_cents, currency, coupon_code,
                             shipping_address_enc, idempotency_key, request_hash, created_at, updated_at)
         VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        orderId,
        userId,
        quote.subtotalCents,
        quote.discountCents,
        quote.totalCents,
        quote.currency,
        quote.couponCode,
        address && needsShipping ? encrypt(JSON.stringify(address), this.config.dataKey) : null,
        idempotencyKey,
        requestHash,
        now,
        now,
      );
      for (const l of quote.lines) {
        this.db.run(
          'INSERT INTO order_items (order_id, edition_id, title, isbn13, format, unit_price_cents, qty) VALUES (?, ?, ?, ?, ?, ?, ?)',
          orderId,
          l.editionId,
          l.title,
          l.isbn13,
          l.format,
          l.unitPriceCents,
          l.qty,
        );
      }
      // Throws INSUFFICIENT_STOCK => whole transaction (order included) rolls back.
      this.inventory.reserve(orderId, quote.lines.map((l) => ({ editionId: l.editionId, qty: l.qty, digital: isDigital(l.format) })));
      this.db.run('DELETE FROM cart_items WHERE user_id = ?', userId);
    });

    try {
      await this.payments.createIntent(orderId, quote.totalCents, quote.currency);
    } catch (e) {
      // Compensation: give the stock back and close the order.
      this.db.tx(() => {
        this.inventory.release(orderId);
        this.setStatus(orderId, 'FAILED');
        this.bus.publish('order.failed', { orderId, userId });
      });
      this.bus.dispatch();
      this.log.error({ event: 'payment_intent_failed', orderId, err: e instanceof Error ? e.message : 'unknown' }, 'payment intent failed');
      throw new AppError(502, 'PAYMENT_UNAVAILABLE', 'Payment provider unavailable; please try again');
    }

    const row = this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', orderId);
    if (!row) throw new Error('order vanished');
    return { order: this.view(row, true), created: true };
  }

  /** Returns undefined when the order does not exist or is not visible to this actor. */
  find(orderId: string, actor: { id: string; role: string }): OrderRow | undefined {
    const o = this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) return undefined;
    const staff = ['admin', 'order_admin', 'support'].includes(actor.role);
    return o.user_id === actor.id || staff ? o : undefined;
  }

  view(o: OrderRow, withSecret: boolean): Obj {
    const items = this.db.all<Obj>(
      'SELECT edition_id AS editionId, title, isbn13, format, unit_price_cents AS unitPriceCents, qty FROM order_items WHERE order_id = ? ORDER BY edition_id',
      o.id,
    );
    const pay = this.db.get<{ status: string; client_secret_enc: string }>('SELECT status, client_secret_enc FROM payments WHERE order_id = ?', o.id);
    const shipment = this.db.get<{ status: string; tracking_number: string | null }>('SELECT status, tracking_number FROM shipments WHERE order_id = ?', o.id);
    return {
      id: o.id,
      status: o.status,
      subtotalCents: o.subtotal_cents,
      discountCents: o.discount_cents,
      totalCents: o.total_cents,
      currency: o.currency,
      couponCode: o.coupon_code,
      items,
      shippingAddress: o.shipping_address_enc ? (JSON.parse(decrypt(o.shipping_address_enc, this.config.dataKey)) as Obj) : null,
      payment: pay
        ? {
            status: pay.status,
            clientSecret: withSecret && pay.status === 'REQUIRES_PAYMENT' ? decrypt(pay.client_secret_enc, this.config.dataKey) : undefined,
          }
        : null,
      shipment: shipment ? { status: shipment.status, trackingNumber: shipment.tracking_number } : null,
      createdAt: o.created_at,
    };
  }

  async cancel(orderId: string): Promise<void> {
    this.db.tx(() => {
      const o = this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', orderId);
      if (!o) throw notFound('Order');
      if (o.status === 'PENDING') {
        this.inventory.release(orderId);
        this.setStatus(orderId, 'CANCELLED');
        this.bus.publish('order.cancelled', { orderId, userId: o.user_id });
      } else if (o.status === 'PAID') {
        const digital = this.db.get("SELECT 1 AS x FROM order_items WHERE order_id = ? AND format IN ('ebook','audiobook')", orderId);
        if (digital) throw conflict('NOT_CANCELLABLE', 'Orders containing delivered digital items cannot be cancelled');
        this.inventory.restock(orderId);
        this.db.run("UPDATE shipments SET status = 'CANCELLED', updated_at = ? WHERE order_id = ?", nowIso(), orderId);
        this.db.run("UPDATE payments SET status = 'NEEDS_REFUND', updated_at = ? WHERE order_id = ? AND status = 'CAPTURED'", nowIso(), orderId);
        this.setStatus(orderId, 'REFUNDED');
        this.bus.publish('order.refunded', { orderId, userId: o.user_id });
      } else {
        throw conflict('NOT_CANCELLABLE', `Order in status ${o.status} cannot be cancelled`);
      }
    });
    this.bus.dispatch();
    await this.payments.processRefunds();
  }

  /** Scheduled job: release stock held by orders that never got paid within the reservation TTL. */
  expireStale(nowMs: number = Date.now()): number {
    const cutoff = new Date(nowMs - this.config.reservationTtlSec * 1000).toISOString();
    const stale = this.db.all<{ id: string; user_id: string }>("SELECT id, user_id FROM orders WHERE status = 'PENDING' AND created_at < ?", cutoff);
    for (const o of stale) {
      this.db.tx(() => {
        this.inventory.release(o.id);
        this.setStatus(o.id, 'CANCELLED');
        this.bus.publish('order.cancelled', { orderId: o.id, userId: o.user_id, reason: 'expired' });
      });
    }
    if (stale.length > 0) this.bus.dispatch();
    return stale.length;
  }

  advance(orderId: string, to: string, trackingNumber: string | undefined): void {
    this.db.tx(() => {
      const o = this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', orderId);
      if (!o) throw notFound('Order');
      const sh = this.db.get<{ id: string }>('SELECT id FROM shipments WHERE order_id = ?', orderId);
      if (!sh || NEXT[o.status] !== to) throw conflict('INVALID_TRANSITION', `Cannot move order from ${o.status} to ${to}`);
      if (to === 'SHIPPED' && !trackingNumber) throw badRequest('INVALID_INPUT', 'trackingNumber is required when shipping');
      this.db.run(
        'UPDATE shipments SET status = ?, tracking_number = COALESCE(?, tracking_number), updated_at = ? WHERE id = ?',
        to,
        trackingNumber ?? null,
        nowIso(),
        sh.id,
      );
      this.setStatus(orderId, to);
      this.bus.publish('order.status_changed', { orderId, userId: o.user_id, status: to });
    });
    this.bus.dispatch();
  }

  list(userId: string | undefined, status: string | undefined, q: Obj): { items: Obj[]; nextCursor: string | null } {
    const limit = pageLimit(q);
    const cur = decodeCursor(queryStr(q, 'cursor', 300));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (userId) {
      where.push('user_id = ?');
      params.push(userId);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (cur) {
      if (typeof cur.c !== 'string' || typeof cur.i !== 'string') throw badRequest('INVALID_INPUT', 'cursor is invalid');
      where.push('(created_at, id) < (?, ?)');
      params.push(cur.c, cur.i);
    }
    const rows = this.db.all<OrderRow>(
      `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((o) => this.view(o, false)),
      nextCursor: rows.length > limit && last ? encodeCursor({ c: last.created_at, i: last.id }) : null,
    };
  }
}

export function registerOrders(app: FastifyInstance, orders: OrderService): void {
  app.post('/v1/checkout', async (req, reply) => {
    const u = requireUser(req);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
      throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-100 chars: A-Z a-z 0-9 _ -) is required');
    }
    const { order, created } = await orders.checkout(u.id, key, asObj(req.body ?? {}));
    if (created) req.log.info({ event: 'order_created', orderId: order.id, userId: u.id }, 'order created');
    return reply.code(created ? 201 : 200).send(order);
  });

  app.get('/v1/orders', async (req) => {
    const u = requireUser(req);
    return orders.list(u.id, undefined, asObj(req.query, 'Query'));
  });

  app.get('/v1/orders/:id', async (req) => {
    const u = requireUser(req);
    const o = orders.find(uuidParam((req.params as Obj).id), u);
    if (!o) throw notFound('Order');
    return orders.view(o, o.user_id === u.id);
  });

  app.post('/v1/orders/:id/cancel', async (req) => {
    const u = requireUser(req);
    const o = orders.find(uuidParam((req.params as Obj).id), u);
    // Only the owner (or order_admin) may cancel; support is read-only.
    if (!o || (o.user_id !== u.id && u.role !== 'order_admin' && u.role !== 'admin')) throw notFound('Order');
    await orders.cancel(o.id);
    req.log.info({ event: 'order_cancelled', orderId: o.id, userId: u.id }, 'order cancelled');
    return { ok: true };
  });

  // ---- Admin ----
  app.get('/v1/admin/orders', async (req) => {
    requireRole(req, 'order_admin', 'support');
    const q = asObj(req.query, 'Query');
    const status = queryStr(q, 'status', 20);
    if (status && !(STATUSES as readonly string[]).includes(status)) throw badRequest('INVALID_INPUT', 'status is invalid');
    return orders.list(undefined, status, q);
  });

  app.patch('/v1/admin/orders/:id/status', async (req) => {
    requireRole(req, 'order_admin');
    const id = uuidParam((req.params as Obj).id);
    const body = asObj(req.body);
    allowKeys(body, ['status', 'trackingNumber']);
    const to = reqEnum(body, 'status', ['PACKED', 'SHIPPED', 'DELIVERED'] as const);
    orders.advance(id, to, optStr(body, 'trackingNumber', 3, 100));
    return { ok: true };
  });
}
