import type { FastifyInstance } from 'fastify';
import type { Db } from './db.ts';
import { isUniqueViolation, nowIso } from './db.ts';
import { requireRole } from './auth.ts';
import { badRequest, conflict, notFound } from './errors.ts';
import {
  allowKeys,
  asObj,
  decodeCursor,
  encodeCursor,
  intParam,
  optInt,
  optStr,
  pageLimit,
  queryInt,
  queryStr,
  reqEnum,
  reqInt,
  reqStr,
} from './validate.ts';
import type { Obj } from './validate.ts';

export const FORMATS = ['hardcover', 'paperback', 'ebook', 'audiobook'] as const;
export type Format = (typeof FORMATS)[number];
export const isDigital = (f: string): boolean => f === 'ebook' || f === 'audiobook';

const SORTS = ['relevance', 'title', 'price_asc', 'price_desc', 'newest'] as const;
const MAX_OFFSET = 10_000;

export function validIsbn13(s: string): boolean {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

/** Turn arbitrary user text into a safe FTS5 prefix query: each token quoted, so no operator injection. */
export function ftsQuery(input: string): string | undefined {
  const tokens = input.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8);
  if (!tokens || tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

interface EditionInput {
  isbn13: string;
  format: Format;
  priceCents: number;
  initialStock: number;
}

function parseEdition(o: Obj): EditionInput {
  allowKeys(o, ['isbn13', 'format', 'priceCents', 'currency', 'initialStock']);
  reqEnum(o, 'currency', ['USD']);
  const isbn13 = reqStr(o, 'isbn13', 13, 13);
  if (!validIsbn13(isbn13)) throw asBad('isbn13 is not a valid ISBN-13');
  const format = reqEnum(o, 'format', FORMATS);
  return {
    isbn13,
    format,
    priceCents: reqInt(o, 'priceCents', 1, 10_000_000),
    initialStock: isDigital(format) ? 0 : (optInt(o, 'initialStock', 0, 1_000_000) ?? 0),
  };
}

function asBad(msg: string): Error {
  return badRequest('INVALID_INPUT', msg);
}

export class CatalogService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insertEdition(bookId: number, e: EditionInput): number {
    try {
      const r = this.db.run(
        "INSERT INTO editions (book_id, isbn13, format, price_cents, currency) VALUES (?, ?, ?, ?, 'USD')",
        bookId,
        e.isbn13,
        e.format,
        e.priceCents,
      );
      if (!isDigital(e.format)) {
        this.db.run('INSERT INTO stock (edition_id, on_hand, reserved) VALUES (?, ?, 0)', r.lastInsertRowid, e.initialStock);
      }
      return r.lastInsertRowid;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('ISBN_EXISTS', 'An edition with this ISBN already exists');
      throw err;
    }
  }

  private indexBook(id: number, title: string, author: string, description: string): void {
    this.db.run('DELETE FROM books_fts WHERE rowid = ?', id);
    this.db.run('INSERT INTO books_fts (rowid, title, author, description) VALUES (?, ?, ?, ?)', id, title, author, description);
  }

  createBook(b: { title: string; author: string; description: string; category: string; language: string }, editions: EditionInput[]): number {
    return this.db.tx(() => {
      const now = nowIso();
      const r = this.db.run(
        'INSERT INTO books (title, author, description, category, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        b.title,
        b.author,
        b.description,
        b.category,
        b.language,
        now,
        now,
      );
      for (const e of editions) this.insertEdition(r.lastInsertRowid, e);
      this.indexBook(r.lastInsertRowid, b.title, b.author, b.description);
      return r.lastInsertRowid;
    });
  }

  updateBook(id: number, b: { title: string; author: string; description: string; category: string; language: string }): void {
    this.db.tx(() => {
      const r = this.db.run(
        'UPDATE books SET title = ?, author = ?, description = ?, category = ?, language = ?, updated_at = ? WHERE id = ?',
        b.title,
        b.author,
        b.description,
        b.category,
        b.language,
        nowIso(),
        id,
      );
      if (r.changes === 0) throw notFound('Book');
      this.indexBook(id, b.title, b.author, b.description);
    });
  }

  getBook(id: number): object {
    const book = this.db.get<Obj>(
      `SELECT b.id, b.title, b.author, b.description, b.category, b.language,
              (SELECT ROUND(AVG(rating), 2) FROM reviews r WHERE r.book_id = b.id) AS avg_rating,
              (SELECT COUNT(*) FROM reviews r WHERE r.book_id = b.id) AS review_count
         FROM books b WHERE b.id = ?`,
      id,
    );
    if (!book) throw notFound('Book');
    const editions = this.db.all<Obj>(
      `SELECT e.id, e.isbn13, e.format, e.price_cents, e.currency,
              CASE WHEN e.format IN ('ebook','audiobook') THEN 1 ELSE COALESCE(s.on_hand - s.reserved, 0) > 0 END AS in_stock
         FROM editions e LEFT JOIN stock s ON s.edition_id = e.id
        WHERE e.book_id = ? AND e.active = 1 ORDER BY e.id`,
      id,
    );
    return { ...book, editions: editions.map((e) => ({ ...e, in_stock: Boolean(e.in_stock) })) };
  }

  search(q: Obj): { items: Obj[]; nextCursor: string | null } {
    const text = queryStr(q, 'query', 200);
    const category = queryStr(q, 'category');
    const author = queryStr(q, 'author');
    const format = queryStr(q, 'format');
    if (format && !(FORMATS as readonly string[]).includes(format)) throw asBad('format is invalid');
    const minPrice = queryInt(q, 'minPrice', 0, 100_000_000);
    const maxPrice = queryInt(q, 'maxPrice', 0, 100_000_000);
    const sortRaw = queryStr(q, 'sort') ?? (text ? 'relevance' : 'newest');
    if (!(SORTS as readonly string[]).includes(sortRaw)) throw asBad('sort is invalid');
    const limit = pageLimit(q);
    const cur = decodeCursor(queryStr(q, 'cursor', 200));
    const offset = cur ? Math.min(Math.max(Number(cur.o) || 0, 0), MAX_OFFSET) : 0;

    const fts = text ? ftsQuery(text) : undefined;
    if (text && !fts) return { items: [], nextCursor: null };

    const where: string[] = [];
    const params: (string | number)[] = [];
    let from = 'books b';
    if (fts) {
      from = 'books_fts f JOIN books b ON b.id = f.rowid';
      where.push('books_fts MATCH ?');
      params.push(fts);
    }
    if (category) {
      where.push('b.category = ? COLLATE NOCASE');
      params.push(category);
    }
    if (author) {
      where.push("b.author LIKE ? ESCAPE '\\'");
      params.push(`%${author.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const edWhere = ['e.book_id = b.id', 'e.active = 1'];
    if (format) {
      edWhere.push('e.format = ?');
      params.push(format);
    }
    if (minPrice !== undefined) {
      edWhere.push('e.price_cents >= ?');
      params.push(minPrice);
    }
    if (maxPrice !== undefined) {
      edWhere.push('e.price_cents <= ?');
      params.push(maxPrice);
    }
    where.push(`EXISTS (SELECT 1 FROM editions e WHERE ${edWhere.join(' AND ')})`);

    const order: Record<string, string> = {
      relevance: fts ? 'bm25(books_fts), b.id' : 'b.id DESC',
      title: 'b.title COLLATE NOCASE, b.id',
      price_asc: 'min_price, b.id',
      price_desc: 'min_price DESC, b.id',
      newest: 'b.id DESC',
    };

    const rows = this.db.all<Obj>(
      `SELECT b.id, b.title, b.author, b.category, b.language,
              (SELECT MIN(price_cents) FROM editions e WHERE e.book_id = b.id AND e.active = 1) AS min_price,
              (SELECT ROUND(AVG(rating), 2) FROM reviews r WHERE r.book_id = b.id) AS avg_rating
         FROM ${from} WHERE ${where.join(' AND ')}
        ORDER BY ${order[sortRaw]} LIMIT ? OFFSET ?`,
      ...params,
      limit + 1,
      offset,
    );
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit),
      nextCursor: hasMore && offset + limit <= MAX_OFFSET ? encodeCursor({ o: offset + limit }) : null,
    };
  }

  suggest(prefix: string): string[] {
    const fts = ftsQuery(prefix);
    if (!fts) return [];
    return this.db
      .all<{ title: string }>(
        'SELECT b.title FROM books_fts f JOIN books b ON b.id = f.rowid WHERE books_fts MATCH ? ORDER BY bm25(books_fts) LIMIT 8',
        fts,
      )
      .map((r) => r.title);
  }

  /** Stock admin. Never allows on_hand below what is reserved. */
  setOnHand(editionId: number, onHand: number): void {
    this.db.tx(() => {
      const ed = this.db.get<{ format: string }>('SELECT format FROM editions WHERE id = ?', editionId);
      if (!ed) throw notFound('Edition');
      if (isDigital(ed.format)) throw conflict('DIGITAL_EDITION', 'Digital editions have no stock');
      const s = this.db.get<{ reserved: number }>('SELECT reserved FROM stock WHERE edition_id = ?', editionId);
      if (!s) throw notFound('Stock');
      if (onHand < s.reserved) throw conflict('BELOW_RESERVED', 'on_hand cannot be lower than reserved units');
      this.db.run('UPDATE stock SET on_hand = ? WHERE edition_id = ?', onHand, editionId);
    });
  }
}

export function registerCatalog(app: FastifyInstance, catalog: CatalogService, db: Db): void {
  const cacheable = (reply: { header: (k: string, v: string) => unknown }) => reply.header('Cache-Control', 'public, max-age=30');

  app.get('/v1/books', async (req, reply) => {
    cacheable(reply);
    return catalog.search(asObj(req.query, 'Query'));
  });

  app.get('/v1/books/:id', async (req, reply) => {
    cacheable(reply);
    return catalog.getBook(intParam((req.params as Obj).id));
  });

  app.get('/v1/editions/:isbn', async (req, reply) => {
    const isbn = (req.params as Obj).isbn;
    if (typeof isbn !== 'string' || !/^\d{13}$/.test(isbn)) throw notFound('Edition');
    const row = db.get<{ book_id: number; id: number }>('SELECT id, book_id FROM editions WHERE isbn13 = ? AND active = 1', isbn);
    if (!row) throw notFound('Edition');
    cacheable(reply);
    return { editionId: row.id, book: catalog.getBook(row.book_id) };
  });

  app.get('/v1/search/suggest', async (req, reply) => {
    cacheable(reply);
    return { suggestions: catalog.suggest(queryStr(asObj(req.query, 'Query'), 'q', 100) ?? '') };
  });

  // ---- Admin (RBAC: catalog_admin) ----
  const bookFields = (b: Obj) => ({
    title: reqStr(b, 'title', 1, 300),
    author: reqStr(b, 'author', 1, 300),
    description: optStr(b, 'description', 0, 5000) ?? '',
    category: reqStr(b, 'category', 1, 100),
    language: optStr(b, 'language', 2, 10) ?? 'en',
  });

  app.post('/v1/admin/books', async (req, reply) => {
    requireRole(req, 'catalog_admin');
    const body = asObj(req.body);
    allowKeys(body, ['title', 'author', 'description', 'category', 'language', 'editions']);
    const raw = body.editions;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) throw asBad('editions must be an array of 1-10 items');
    const editions = raw.map((e) => parseEdition(asObj(e, 'edition')));
    const id = catalog.createBook(bookFields(body), editions);
    req.log.info({ event: 'book_created', bookId: id, userId: req.user?.id }, 'book created');
    return reply.code(201).send(catalog.getBook(id));
  });

  app.put('/v1/admin/books/:id', async (req) => {
    requireRole(req, 'catalog_admin');
    const id = intParam((req.params as Obj).id);
    const body = asObj(req.body);
    allowKeys(body, ['title', 'author', 'description', 'category', 'language']);
    catalog.updateBook(id, bookFields(body));
    return catalog.getBook(id);
  });

  app.post('/v1/admin/books/:id/editions', async (req, reply) => {
    requireRole(req, 'catalog_admin');
    const bookId = intParam((req.params as Obj).id);
    const edition = parseEdition(asObj(req.body));
    if (!db.get('SELECT 1 AS x FROM books WHERE id = ?', bookId)) throw notFound('Book');
    const id = db.tx(() => catalog.insertEdition(bookId, edition));
    return reply.code(201).send({ editionId: id });
  });

  app.patch('/v1/admin/editions/:id', async (req) => {
    requireRole(req, 'catalog_admin');
    const id = intParam((req.params as Obj).id);
    const body = asObj(req.body);
    allowKeys(body, ['priceCents', 'active']);
    const price = optInt(body, 'priceCents', 1, 10_000_000);
    const active = body.active;
    if (active !== undefined && typeof active !== 'boolean') throw asBad('active must be a boolean');
    if (price === undefined && active === undefined) throw asBad('Nothing to update');
    const r = db.run(
      'UPDATE editions SET price_cents = COALESCE(?, price_cents), active = COALESCE(?, active) WHERE id = ?',
      price ?? null,
      active === undefined ? null : active ? 1 : 0,
      id,
    );
    if (r.changes === 0) throw notFound('Edition');
    req.log.info({ event: 'edition_updated', editionId: id, userId: req.user?.id }, 'edition updated');
    return { ok: true };
  });

  app.patch('/v1/admin/inventory/:editionId', async (req) => {
    requireRole(req, 'catalog_admin', 'order_admin');
    const id = intParam((req.params as Obj).editionId, 'editionId');
    const body = asObj(req.body);
    allowKeys(body, ['onHand']);
    catalog.setOnHand(id, reqInt(body, 'onHand', 0, 1_000_000));
    return { ok: true };
  });
}
