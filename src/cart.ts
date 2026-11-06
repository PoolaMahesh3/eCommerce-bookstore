import type { FastifyInstance } from 'fastify';
import type { Db } from './db.ts';
import { isUniqueViolation, nowIso } from './db.ts';
import { requireRole, requireUser } from './auth.ts';
import { badRequest, conflict, notFound } from './errors.ts';
import { isDigital } from './catalog.ts';
import { allowKeys, asObj, intParam, optStr, queryStr, reqInt, reqStr } from './validate.ts';
import type { Obj } from './validate.ts';

export interface QuoteLine {
  editionId: number;
  bookId: number;
  title: string;
  isbn13: string;
  format: string;
  unitPriceCents: number;
  qty: number;
  lineCents: number;
}

export interface Quote {
  lines: QuoteLine[];
  currency: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponCode: string | null;
}

interface CartRow {
  edition_id: number;
  book_id: number;
  title: string;
  isbn13: string;
  format: string;
  price_cents: number;
  currency: string;
  qty: number;
}

export class PricingService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  percentFor(code: string | undefined): { code: string; percent: number } | undefined {
    if (!code) return undefined;
    const c = this.db.get<{ code: string; percent_off: number; active: number; expires_at: string | null }>(
      'SELECT code, percent_off, active, expires_at FROM coupons WHERE code = ?',
      code.trim().toUpperCase(),
    );
    if (!c || !c.active || (c.expires_at && c.expires_at <= nowIso())) {
      throw badRequest('INVALID_COUPON', 'Coupon is not valid');
    }
    return { code: c.code, percent: c.percent_off };
  }

  /** Re-prices the user's cart from the catalog (never trusts client prices). */
  quoteCart(userId: string, couponCode?: string): Quote {
    const rows = this.db.all<CartRow>(
      `SELECT c.edition_id, e.book_id, b.title, e.isbn13, e.format, e.price_cents, e.currency, c.qty
         FROM cart_items c
         JOIN editions e ON e.id = c.edition_id AND e.active = 1
         JOIN books b ON b.id = e.book_id
        WHERE c.user_id = ? ORDER BY c.edition_id`,
      userId,
    );
    const lines: QuoteLine[] = rows.map((r) => ({
      editionId: r.edition_id,
      bookId: r.book_id,
      title: r.title,
      isbn13: r.isbn13,
      format: r.format,
      unitPriceCents: r.price_cents,
      qty: r.qty,
      lineCents: r.price_cents * r.qty,
    }));
    const subtotal = lines.reduce((s, l) => s + l.lineCents, 0);
    const coupon = this.percentFor(couponCode);
    const discount = coupon ? Math.floor((subtotal * coupon.percent) / 100) : 0;
    return {
      lines,
      currency: 'USD',
      subtotalCents: subtotal,
      discountCents: discount,
      totalCents: subtotal - discount,
      couponCode: coupon?.code ?? null,
    };
  }
}

export function registerCart(app: FastifyInstance, db: Db, pricing: PricingService): void {
  app.get('/v1/cart', async (req) => {
    const u = requireUser(req);
    const coupon = queryStr(asObj(req.query, 'Query'), 'coupon', 40);
    return pricing.quoteCart(u.id, coupon);
  });

  app.put('/v1/cart/items/:editionId', async (req) => {
    const u = requireUser(req);
    const editionId = intParam((req.params as Obj).editionId, 'editionId');
    const body = asObj(req.body);
    allowKeys(body, ['qty']);
    const qty = reqInt(body, 'qty', 1, 20);
    const ed = db.get<{ format: string }>('SELECT format FROM editions WHERE id = ? AND active = 1', editionId);
    if (!ed) throw notFound('Edition');
    if (isDigital(ed.format) && qty !== 1) throw badRequest('INVALID_INPUT', 'Digital editions are limited to quantity 1');
    db.run(
      `INSERT INTO cart_items (user_id, edition_id, qty, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, edition_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`,
      u.id,
      editionId,
      qty,
      nowIso(),
    );
    return pricing.quoteCart(u.id);
  });

  app.delete('/v1/cart/items/:editionId', async (req) => {
    const u = requireUser(req);
    db.run('DELETE FROM cart_items WHERE user_id = ? AND edition_id = ?', u.id, intParam((req.params as Obj).editionId, 'editionId'));
    return pricing.quoteCart(u.id);
  });

  app.post('/v1/admin/coupons', async (req, reply) => {
    requireRole(req, 'catalog_admin');
    const body = asObj(req.body);
    allowKeys(body, ['code', 'percentOff', 'expiresAt']);
    const code = reqStr(body, 'code', 3, 40).toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(code)) throw badRequest('INVALID_INPUT', 'code may contain only A-Z, 0-9, _ and -');
    const percent = reqInt(body, 'percentOff', 1, 90);
    const expires = optStr(body, 'expiresAt', 10, 40);
    if (expires !== undefined && Number.isNaN(Date.parse(expires))) throw badRequest('INVALID_INPUT', 'expiresAt must be an ISO date');
    try {
      db.run(
        'INSERT INTO coupons (code, percent_off, active, expires_at) VALUES (?, ?, 1, ?)',
        code,
        percent,
        expires ? new Date(expires).toISOString() : null,
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('COUPON_EXISTS', 'Coupon already exists');
      throw e;
    }
    return reply.code(201).send({ code, percentOff: percent });
  });
}
