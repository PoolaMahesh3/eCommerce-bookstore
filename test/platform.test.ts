import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { ENV, ADDRESS, addToCart, bearer, checkout, createBook, makeApp, pay, signup } from './helpers.ts';
import type { Session } from './helpers.ts';

let a: App;
let admin: Session;
const json = <T = Record<string, any>>(r: { json(): unknown }): T => r.json() as T;

before(async () => {
  a = await makeApp();
  admin = await signup(a, 'catalog_admin');
});
after(async () => {
  await a.app.close();
});

async function buy(u: Session, editionId: number, body: object = { shippingAddress: ADDRESS }) {
  await addToCart(a, u, editionId, 1);
  const order = json(await checkout(a, u, body));
  await pay(a, order.id);
  return order.id as string;
}

describe('digital delivery', () => {
  test('ebook purchase: no stock/shipping, entitlement granted, signed expiring single-user download', async () => {
    const u = await signup(a);
    const { editionId, bookId } = await createBook(a, admin, { format: 'ebook', price: 999 });
    const orderId = await buy(u, editionId, {}); // no address needed
    const order = json(await a.app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: bearer(u) }));
    assert.equal(order.status, 'DELIVERED');
    assert.equal(order.shipment, null);
    assert.equal(a.db.get('SELECT 1 AS x FROM stock WHERE edition_id = ?', editionId), undefined);

    const lib = json(await a.app.inject({ method: 'GET', url: '/v1/library', headers: bearer(u) }));
    assert.equal(lib.items[0].editionId, editionId);

    const link = json(await a.app.inject({ method: 'POST', url: `/v1/library/${editionId}/download-link`, headers: bearer(u) }));
    assert.match(link.url, /^\/v1\/downloads\/[A-Za-z0-9_-]{43}$/);
    assert.equal((await a.app.inject({ method: 'GET', url: link.url, headers: bearer(u) })).statusCode, 200);

    const other = await signup(a);
    assert.equal((await a.app.inject({ method: 'GET', url: link.url, headers: bearer(other) })).statusCode, 404); // not transferable
    assert.equal((await a.app.inject({ method: 'GET', url: link.url })).statusCode, 401);
    assert.equal((await a.app.inject({ method: 'POST', url: `/v1/library/${editionId}/download-link`, headers: bearer(other) })).statusCode, 404);

    a.db.run("UPDATE download_links SET expires_at = '2000-01-01T00:00:00.000Z'");
    assert.equal((await a.app.inject({ method: 'GET', url: link.url, headers: bearer(u) })).statusCode, 404); // expired

    // Cannot buy the same ebook twice; paid ebook orders are not cancellable.
    await addToCart(a, u, editionId, 1);
    assert.equal(json(await checkout(a, u, {})).code, 'ALREADY_OWNED');
    assert.equal((await a.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/cancel`, headers: bearer(u) })).statusCode, 409);

    // Verified-purchase reviews, one per user.
    const rv = (s: Session) => a.app.inject({ method: 'POST', url: `/v1/books/${bookId}/reviews`, headers: bearer(s), payload: { rating: 5, body: 'Great' } });
    assert.equal((await rv(other)).statusCode, 403);
    assert.equal((await rv(u)).statusCode, 201);
    assert.equal((await rv(u)).statusCode, 409);
    const list = json(await a.app.inject({ method: 'GET', url: `/v1/books/${bookId}/reviews` }));
    assert.equal(list.items.length, 1);
    assert.equal(json(await a.app.inject({ method: 'GET', url: `/v1/books/${bookId}` })).avg_rating, 5);
  });

  test('digital quantity is limited to 1 and also-bought reflects co-purchases', async () => {
    const u = await signup(a);
    const e1 = await createBook(a, admin, { format: 'ebook' });
    assert.equal((await addToCart(a, u, e1.editionId, 2)).statusCode, 400);

    const p1 = await createBook(a, admin, { title: 'Anchor Book', stock: 5 });
    const p2 = await createBook(a, admin, { title: 'Companion Book', stock: 5 });
    await addToCart(a, u, p1.editionId, 1);
    await addToCart(a, u, p2.editionId, 1);
    const order = json(await checkout(a, u));
    await pay(a, order.id);
    const rec = json(await a.app.inject({ method: 'GET', url: `/v1/books/${p1.bookId}/also-bought` }));
    assert.deepEqual(rec.items.map((i: any) => i.title), ['Companion Book']);
  });
});

describe('platform hardening', () => {
  test('security headers, no-store on private data, generic 404/415', async () => {
    const r = await a.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.headers['strict-transport-security']);
    assert.equal(r.headers['cache-control'], 'no-store');
    const u = await signup(a);
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/cart', headers: bearer(u) })).headers['cache-control'], 'no-store');
    assert.equal((await a.app.inject({ method: 'GET', url: '/nope' })).statusCode, 404);
    const xml = await a.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'text/xml' }, payload: '<a/>' });
    assert.equal(xml.statusCode, 415);
    const badJson = await a.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{oops' });
    assert.equal(badJson.statusCode, 400);
    assert.ok(!badJson.body.includes('Unexpected'));
  });

  test('rate limiting returns 429 with Retry-After', async () => {
    const limited = await makeApp({ AUTH_RATE_LIMIT_PER_MIN: '3' });
    try {
      const codes: number[] = [];
      let retry: unknown;
      for (let i = 0; i < 5; i++) {
        const r = await limited.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'x@example.com', password: 'whatever-pass' } });
        codes.push(r.statusCode);
        retry = r.headers['retry-after'] ?? retry;
      }
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
      assert.ok(retry);
    } finally {
      await limited.app.close();
    }
  });

  test('config refuses unsafe settings', () => {
    assert.throws(() => loadConfig({ ...ENV, HOST: '0.0.0.0' }), /wildcard/);
    assert.throws(() => loadConfig({ ...ENV, JWT_SECRET: 'short' }), /JWT_SECRET/);
    assert.throws(() => loadConfig({ ...ENV, DATA_KEY: randomBytes(16).toString('base64') }), /DATA_KEY/);
    assert.throws(() => loadConfig({ ...ENV, WEBHOOK_SECRET: undefined }), /WEBHOOK_SECRET/);
    assert.throws(() => loadConfig({ ...ENV, OIDC_ISSUER: 'https://idp', OIDC_AUDIENCE: 'x', OIDC_JWKS_URL: 'http://idp/jwks' }), /https/);
    assert.equal(loadConfig(ENV).host, '127.0.0.1');
  });

  test('bootstrap admin is seeded from environment and can administer', async () => {
    const seeded = await makeApp({ ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'a-very-long-admin-pass' });
    try {
      const l = await seeded.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'root@example.com', password: 'a-very-long-admin-pass' } });
      assert.equal(l.statusCode, 200);
      const t = { authorization: `Bearer ${json(l).accessToken}` };
      assert.equal((await seeded.app.inject({ method: 'GET', url: '/v1/admin/orders', headers: t })).statusCode, 200);
    } finally {
      await seeded.app.close();
    }
  });

  test('events that keep failing are dead-lettered after 5 attempts', async () => {
    a.bus.subscribe('test.poison', 'poison', () => {
      throw new Error('boom');
    });
    a.bus.publish('test.poison', { x: 1 });
    for (let i = 0; i < 6; i++) a.bus.dispatch();
    const row = a.db.get<{ dead: number; attempts: number }>("SELECT dead, attempts FROM outbox WHERE topic = 'test.poison'")!;
    assert.equal(row.dead, 1);
    assert.equal(row.attempts, 5);
  });
});
