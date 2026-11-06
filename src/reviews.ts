import type { FastifyInstance } from 'fastify';
import type { Db } from './db.ts';
import { isUniqueViolation, nowIso } from './db.ts';
import { requireUser } from './auth.ts';
import { conflict, forbidden, notFound } from './errors.ts';
import { allowKeys, asObj, decodeCursor, encodeCursor, intParam, pageLimit, queryStr, reqInt, reqStr } from './validate.ts';
import type { Obj } from './validate.ts';

export function registerReviews(app: FastifyInstance, db: Db): void {
  app.get('/v1/books/:id/reviews', async (req, reply) => {
    const bookId = intParam((req.params as Obj).id);
    if (!db.get('SELECT 1 AS x FROM books WHERE id = ?', bookId)) throw notFound('Book');
    const q = asObj(req.query, 'Query');
    const limit = pageLimit(q);
    const cur = decodeCursor(queryStr(q, 'cursor', 100));
    const before = cur && typeof cur.i === 'number' ? cur.i : Number.MAX_SAFE_INTEGER;
    const rows = db.all<{ id: number; rating: number; body: string; created_at: string; name: string }>(
      `SELECT r.id, r.rating, r.body, r.created_at, u.name
         FROM reviews r JOIN users u ON u.id = r.user_id
        WHERE r.book_id = ? AND r.id < ? ORDER BY r.id DESC LIMIT ?`,
      bookId,
      before,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    reply.header('Cache-Control', 'public, max-age=30');
    return {
      items: page.map((r) => ({ id: r.id, rating: r.rating, body: r.body, author: r.name, createdAt: r.created_at })),
      nextCursor: rows.length > limit && last ? encodeCursor({ i: last.id }) : null,
    };
  });

  app.post('/v1/books/:id/reviews', async (req, reply) => {
    const u = requireUser(req);
    const bookId = intParam((req.params as Obj).id);
    const body = asObj(req.body);
    allowKeys(body, ['rating', 'body']);
    const rating = reqInt(body, 'rating', 1, 5);
    const text = reqStr(body, 'body', 1, 2000);
    if (!db.get('SELECT 1 AS x FROM books WHERE id = ?', bookId)) throw notFound('Book');
    // Anti-spam: only verified purchasers (a paid order containing this book) can review.
    const bought = db.get(
      `SELECT 1 AS x FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN editions e ON e.id = oi.edition_id
        WHERE o.user_id = ? AND e.book_id = ? AND o.status IN ('PAID','PACKED','SHIPPED','DELIVERED') LIMIT 1`,
      u.id,
      bookId,
    );
    if (!bought) throw forbidden();
    try {
      const r = db.run('INSERT INTO reviews (book_id, user_id, rating, body, created_at) VALUES (?, ?, ?, ?, ?)', bookId, u.id, rating, text, nowIso());
      return reply.code(201).send({ id: r.lastInsertRowid });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('ALREADY_REVIEWED', 'You have already reviewed this book');
      throw e;
    }
  });

  // "Customers also bought": co-purchase counts over paid orders (a precomputed table in production).
  app.get('/v1/books/:id/also-bought', async (req, reply) => {
    const bookId = intParam((req.params as Obj).id);
    reply.header('Cache-Control', 'public, max-age=60');
    return {
      items: db.all<Obj>(
        `SELECT b2.id, b2.title, b2.author, COUNT(DISTINCT o.id) AS together
           FROM editions e1
           JOIN order_items oi1 ON oi1.edition_id = e1.id
           JOIN orders o ON o.id = oi1.order_id AND o.status IN ('PAID','PACKED','SHIPPED','DELIVERED')
           JOIN order_items oi2 ON oi2.order_id = o.id
           JOIN editions e2 ON e2.id = oi2.edition_id AND e2.book_id <> e1.book_id
           JOIN books b2 ON b2.id = e2.book_id
          WHERE e1.book_id = ?
          GROUP BY b2.id ORDER BY together DESC, b2.id LIMIT 10`,
        bookId,
      ),
    };
  });
}
