import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { App } from '../src/app.ts';
import { ADDRESS, addToCart, bearer, checkout, createBook, makeApp, newKey, pay, signWebhook, signup, stock } from './helpers.ts';
import type { Session } from './helpers.ts';

let a: App;
let admin: Session;
let alice: Session;
let bob: Session;

before(async () => {
  a = await makeApp();
  admin = await signup(a, 'catalog_admin');
  alice = await signup(a);
  bob = await signup(a);
});
after(async () => {
  await a.app.close();
});

const json = <T = Record<string, any>>(r: { json(): unknown }): T => r.json() as T;

describe('auth', () => {
  test('rejects missing, malformed and forged tokens', async () => {
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/cart' })).statusCode, 401);
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/cart', headers: { authorization: 'Bearer not.a.jwt' } })).statusCode, 401);
    const forged = alice.token.slice(0, -4) + 'AAAA';
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/cart', headers: { authorization: `Bearer ${forged}` } })).statusCode, 401);
  });

  test('wrong password and unknown user give identical errors', async () => {
    const bad = await a.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: alice.email, password: 'wrong-password-123' } });
    const unknown = await a.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'nobody@example.com', password: 'wrong-password-123' } });
    assert.equal(bad.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.equal(json(bad).message, json(unknown).message);
  });

  test('duplicate email and weak password are rejected', async () => {
    const dup = await a.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: alice.email, name: 'x', password: 'long enough password' } });
    assert.equal(dup.statusCode, 409);
    const weak = await a.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'new@example.com', name: 'x', password: 'short' } });
    assert.equal(weak.statusCode, 400);
  });

  test('RBAC: customers cannot use admin endpoints', async () => {
    const r = await a.app.inject({ method: 'POST', url: '/v1/admin/books', headers: bearer(alice), payload: {} });
    assert.equal(r.statusCode, 403);
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/admin/orders', headers: bearer(alice) })).statusCode, 403);
  });

  test('passwords are stored as scrypt hashes and error bodies carry a trace id', async () => {
    const row = a.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?', alice.email)!;
    assert.match(row.password_hash, /^scrypt\$\d+\$/);
    assert.ok(!row.password_hash.includes('correct horse'));
    const r = await a.app.inject({ method: 'GET', url: '/v1/cart' });
    assert.ok(json(r).traceId);
  });
});

describe('catalog & search', () => {
  test('search, facets, autocomplete and detail', async () => {
    const { bookId } = await createBook(a, admin, { title: 'Designing Data Intensive Applications', category: 'Databases', price: 4500 });
    await createBook(a, admin, { title: 'Cooking for Engineers', category: 'Food', price: 1500 });

    const s = json(await a.app.inject({ method: 'GET', url: '/v1/books?query=data+intensive' }));
    assert.equal(s.items[0].id, bookId);
    const f = json(await a.app.inject({ method: 'GET', url: '/v1/books?category=food&maxPrice=2000' }));
    assert.ok(f.items.every((i: any) => i.category === 'Food'));
    const sug = json(await a.app.inject({ method: 'GET', url: '/v1/search/suggest?q=desig' }));
    assert.ok(sug.suggestions.includes('Designing Data Intensive Applications'));
    const d = json(await a.app.inject({ method: 'GET', url: `/v1/books/${bookId}` }));
    assert.equal(d.editions[0].in_stock, true);
  });

  test('FTS operators in user input cannot break or inject queries', async () => {
    for (const q of ['"', 'a OR b', 'title:foo*', "') ; DROP TABLE books;--", 'NEAR(', '*']) {
      const r = await a.app.inject({ method: 'GET', url: `/v1/books?query=${encodeURIComponent(q)}` });
      assert.equal(r.statusCode, 200, `query ${q}`);
    }
    assert.ok(a.db.get('SELECT 1 AS x FROM books LIMIT 1'));
  });

  test('cursor pagination walks all results without duplicates', async () => {
    for (let i = 0; i < 5; i++) await createBook(a, admin, { title: `Pagination Title ${i}`, category: 'Paging' });
    const seen = new Set<number>();
    let url = '/v1/books?category=Paging&limit=2';
    for (let guard = 0; guard < 10; guard++) {
      const p = json(await a.app.inject({ method: 'GET', url }));
      for (const it of p.items) {
        assert.ok(!seen.has(it.id));
        seen.add(it.id);
      }
      if (!p.nextCursor) break;
      url = `/v1/books?category=Paging&limit=2&cursor=${p.nextCursor}`;
    }
    assert.equal(seen.size, 5);
  });

  test('invalid input is rejected: bad ISBN checksum, unknown fields, bad cursor, bad id', async () => {
    const bad = await a.app.inject({
      method: 'POST',
      url: '/v1/admin/books',
      headers: bearer(admin),
      payload: { title: 'x', author: 'y', category: 'z', editions: [{ isbn13: '9780000000000', format: 'paperback', priceCents: 100, currency: 'USD' }] },
    });
    assert.equal(bad.statusCode, 400);
    const extra = await a.app.inject({
      method: 'POST',
      url: '/v1/admin/books',
      headers: bearer(admin),
      payload: { title: 'x', author: 'y', category: 'z', isAdmin: true, editions: [] },
    });
    assert.equal(extra.statusCode, 400);
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/books?cursor=%%%' })).statusCode, 400);
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/books/abc' })).statusCode, 400);
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/books/999999' })).statusCode, 404);
  });
});

describe('cart & pricing', () => {
  test('server computes totals; coupons apply; client cannot set prices', async () => {
    const { editionId } = await createBook(a, admin, { price: 1000 });
    await a.app.inject({ method: 'POST', url: '/v1/admin/coupons', headers: bearer(admin), payload: { code: 'SAVE10', percentOff: 10 } });
    const put = await a.app.inject({ method: 'PUT', url: `/v1/cart/items/${editionId}`, headers: bearer(bob), payload: { qty: 3, priceCents: 1 } });
    assert.equal(put.statusCode, 400); // unknown field rejected
    const ok = json(await addToCart(a, bob, editionId, 3));
    assert.equal(ok.subtotalCents, 3000);
    const withCoupon = json(await a.app.inject({ method: 'GET', url: '/v1/cart?coupon=save10', headers: bearer(bob) }));
    assert.equal(withCoupon.discountCents, 300);
    assert.equal(withCoupon.totalCents, 2700);
    assert.equal((await a.app.inject({ method: 'GET', url: '/v1/cart?coupon=NOPE', headers: bearer(bob) })).statusCode, 400);
    await a.app.inject({ method: 'DELETE', url: `/v1/cart/items/${editionId}`, headers: bearer(bob) });
  });

  test('carts are isolated per user', async () => {
    const { editionId } = await createBook(a, admin);
    await addToCart(a, alice, editionId, 2);
    assert.equal(json(await a.app.inject({ method: 'GET', url: '/v1/cart', headers: bearer(bob) })).lines.length, 0);
    await a.app.inject({ method: 'DELETE', url: `/v1/cart/items/${editionId}`, headers: bearer(alice) });
  });
});

describe('checkout saga', () => {
  test('happy path: reserve -> pay -> commit -> ship -> deliver, with notifications', async () => {
    const u = await signup(a);
    const { editionId } = await createBook(a, admin, { stock: 5, price: 2500 });
    await addToCart(a, u, editionId, 2);
    const c = await checkout(a, u);
    assert.equal(c.statusCode, 201);
    const order = json(c);
    assert.equal(order.status, 'PENDING');
    assert.equal(order.totalCents, 5000);
    assert.ok(order.payment.clientSecret);
    assert.deepEqual(stock(a, editionId), { on_hand: 5, reserved: 2 });

    assert.equal((await pay(a, order.id)).statusCode, 200);
    const paid = json(await a.app.inject({ method: 'GET', url: `/v1/orders/${order.id}`, headers: bearer(u) }));
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.payment.clientSecret, undefined);
    assert.deepEqual(stock(a, editionId), { on_hand: 3, reserved: 0 });
    assert.equal(paid.shipment.status, 'PENDING');

    const ops = await signup(a, 'order_admin');
    const patch = (status: string, trackingNumber?: string) =>
      a.app.inject({ method: 'PATCH', url: `/v1/admin/orders/${order.id}/status`, headers: bearer(ops), payload: { status, trackingNumber } });
    assert.equal((await patch('SHIPPED', 'TRK123')).statusCode, 409); // cannot skip PACKED
    assert.equal((await patch('PACKED')).statusCode, 200);
    assert.equal((await patch('SHIPPED')).statusCode, 400); // tracking required
    assert.equal((await patch('SHIPPED', 'TRK123')).statusCode, 200);
    assert.equal((await patch('DELIVERED')).statusCode, 200);

    const final = json(await a.app.inject({ method: 'GET', url: `/v1/orders/${order.id}`, headers: bearer(u) }));
    assert.equal(final.status, 'DELIVERED');
    assert.equal(final.shipment.trackingNumber, 'TRK123');
    const notes = json(await a.app.inject({ method: 'GET', url: '/v1/notifications', headers: bearer(u) }));
    assert.ok(notes.items.some((n: any) => n.kind === 'order.paid'));
    assert.ok(notes.items.some((n: any) => n.kind === 'order.status_changed'));
  });

  test('empty cart, missing address and missing idempotency key are rejected', async () => {
    const u = await signup(a);
    assert.equal((await checkout(a, u)).statusCode, 400);
    const { editionId } = await createBook(a, admin);
    await addToCart(a, u, editionId);
    assert.equal(json(await checkout(a, u, {})).code, 'ADDRESS_REQUIRED');
    const noKey = await a.app.inject({ method: 'POST', url: '/v1/checkout', headers: bearer(u), payload: { shippingAddress: ADDRESS } });
    assert.equal(json(noKey).code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  test('idempotency: same key replays the same order; different body is rejected; one reservation only', async () => {
    const u = await signup(a);
    const { editionId } = await createBook(a, admin, { stock: 3 });
    await addToCart(a, u, editionId, 1);
    const key = newKey();
    const first = await checkout(a, u, { shippingAddress: ADDRESS }, key);
    const second = await checkout(a, u, { shippingAddress: ADDRESS }, key);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.equal(json(first).id, json(second).id);
    assert.equal(stock(a, editionId).reserved, 1);
    const diff = await checkout(a, u, { shippingAddress: { ...ADDRESS, city: 'Elsewhere' } }, key);
    assert.equal(diff.statusCode, 422);
  });

  test('NO OVERSELL: concurrent checkouts for the last copies', async () => {
    const { editionId } = await createBook(a, admin, { stock: 3 });
    const buyers = await Promise.all(Array.from({ length: 8 }, () => signup(a)));
    for (const b of buyers) await addToCart(a, b, editionId, 1);
    const results = await Promise.all(buyers.map((b) => checkout(a, b)));
    const ok = results.filter((r) => r.statusCode === 201).length;
    const rejected = results.filter((r) => r.statusCode === 409);
    assert.equal(ok, 3);
    assert.equal(rejected.length, 5);
    assert.ok(rejected.every((r) => json(r).code === 'INSUFFICIENT_STOCK'));
    assert.deepEqual(stock(a, editionId), { on_hand: 3, reserved: 3 });
    // A failed multi-line order must not leave partial reservations or orders behind.
    const orders = a.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.edition_id = ?', editionId)!;
    assert.equal(orders.n, 3);
  });

  test('multi-item order is all-or-nothing', async () => {
    const u = await signup(a);
    const plenty = await createBook(a, admin, { stock: 10 });
    const scarce = await createBook(a, admin, { stock: 1 });
    await addToCart(a, u, plenty.editionId, 2);
    await addToCart(a, u, scarce.editionId, 2);
    const r = await checkout(a, u);
    assert.equal(r.statusCode, 409);
    assert.deepEqual(stock(a, plenty.editionId), { on_hand: 10, reserved: 0 });
    assert.equal(json(await a.app.inject({ method: 'GET', url: '/v1/cart', headers: bearer(u) })).lines.length, 2); // cart kept
  });

  test('payment failure releases stock and fails the order; late success is refunded', async () => {
    const u = await signup(a);
    const { editionId } = await createBook(a, admin, { stock: 2 });
    await addToCart(a, u, editionId, 2);
    const order = json(await checkout(a, u));
    await pay(a, order.id, 'payment.failed');
    assert.equal(json(await a.app.inject({ method: 'GET', url: `/v1/orders/${order.id}`, headers: bearer(u) })).status, 'FAILED');
    assert.deepEqual(stock(a, editionId), { on_hand: 2, reserved: 0 });
    // Provider retries and later reports success for an order we already closed -> refund compensation.
    await pay(a, order.id, 'payment.succeeded');
    const p = a.db.get<{ status: string }>('SELECT status FROM payments WHERE order_id = ?', order.id)!;
    assert.equal(p.status, 'REFUNDED');
    assert.deepEqual(stock(a, editionId), { on_hand: 2, reserved: 0 });
  });

  test('customer cancel of pending order releases stock; expiry job releases stale reservations', async () => {
    const u = await signup(a);
    const { editionId } = await createBook(a, admin, { stock: 4 });
    await addToCart(a, u, editionId, 1);
    const o1 = json(await checkout(a, u));
    assert.equal((await a.app.inject({ method: 'POST', url: `/v1/orders/${o1.id}/cancel`, headers: bearer(u) })).statusCode, 200);
    assert.equal(stock(a, editionId).reserved, 0);

    await addToCart(a, u, editionId, 2);
    const o2 = json(await checkout(a, u));
    assert.equal(stock(a, editionId).reserved, 2);
    const orderStatus = () => a.db.get<{ status: string }>('SELECT status FROM orders WHERE id = ?', o2.id)!.status;
    a.orders.expireStale(Date.now());
    assert.equal(orderStatus(), 'PENDING'); // still inside the reservation TTL
    a.orders.expireStale(Date.now() + 16 * 60_000);
    assert.equal(orderStatus(), 'CANCELLED');
    assert.equal(stock(a, editionId).reserved, 0);
    assert.equal(json(await a.app.inject({ method: 'GET', url: `/v1/orders/${o2.id}`, headers: bearer(u) })).status, 'CANCELLED');
  });

  test('cancelling a paid, unshipped order restocks and refunds', async () => {
    const u = await signup(a);
    const { editionId } = await createBook(a, admin, { stock: 2 });
    await addToCart(a, u, editionId, 1);
    const order = json(await checkout(a, u));
    await pay(a, order.id);
    assert.equal(stock(a, editionId).on_hand, 1);
    assert.equal((await a.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/cancel`, headers: bearer(u) })).statusCode, 200);
    assert.deepEqual(stock(a, editionId), { on_hand: 2, reserved: 0 });
    const p = a.db.get<{ status: string }>('SELECT status FROM payments WHERE order_id = ?', order.id)!;
    assert.equal(p.status, 'REFUNDED');
    assert.equal((await a.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/cancel`, headers: bearer(u) })).statusCode, 409);
  });

  test('shipping addresses are encrypted at rest and orders are private to their owner', async () => {
    const u = await signup(a);
    const { editionId } = await createBook(a, admin);
    await addToCart(a, u, editionId);
    const order = json(await checkout(a, u));
    const raw = a.db.get<{ shipping_address_enc: string }>('SELECT shipping_address_enc FROM orders WHERE id = ?', order.id)!;
    assert.ok(!raw.shipping_address_enc.includes('Springfield'));
    assert.equal(order.shippingAddress.city, 'Springfield');
    const other = await signup(a);
    assert.equal((await a.app.inject({ method: 'GET', url: `/v1/orders/${order.id}`, headers: bearer(other) })).statusCode, 404);
    assert.equal((await a.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/cancel`, headers: bearer(other) })).statusCode, 404);
    const support = await signup(a, 'support');
    assert.equal((await a.app.inject({ method: 'GET', url: `/v1/orders/${order.id}`, headers: bearer(support) })).statusCode, 200);
    assert.equal((await a.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/cancel`, headers: bearer(support) })).statusCode, 404);
    const list = json(await a.app.inject({ method: 'GET', url: '/v1/orders', headers: bearer(other) }));
    assert.equal(list.items.length, 0);
  });

  test('payment provider outage compensates: stock released, order FAILED, 502 to client', async () => {
    const down = await makeApp({}, {
      createIntent: async () => {
        throw new Error('provider down');
      },
      refund: async () => {},
    });
    try {
      const adm = await signup(down, 'catalog_admin');
      const u = await signup(down);
      const { editionId } = await createBook(down, adm, { stock: 2 });
      await addToCart(down, u, editionId, 1);
      const r = await checkout(down, u);
      assert.equal(r.statusCode, 502);
      assert.equal(JSON.stringify(json(r)).includes('provider down'), false);
      assert.deepEqual(stock(down, editionId), { on_hand: 2, reserved: 0 });
      const o = down.db.get<{ status: string }>('SELECT status FROM orders LIMIT 1')!;
      assert.equal(o.status, 'FAILED');
    } finally {
      await down.app.close();
    }
  });
});

describe('payment webhook security', () => {
  async function pendingOrder() {
    const u = await signup(a);
    const { editionId } = await createBook(a, admin, { stock: 2, price: 1000 });
    await addToCart(a, u, editionId, 1);
    const order = json(await checkout(a, u));
    const p = a.db.get<{ provider_ref: string }>('SELECT provider_ref FROM payments WHERE order_id = ?', order.id)!;
    return { u, order, providerRef: p.provider_ref };
  }
  const post = (raw: string, headers: Record<string, string>) => a.app.inject({ method: 'POST', url: '/v1/payments/webhook', headers, payload: raw });
  const status = (id: string) => a.db.get<{ status: string }>('SELECT status FROM orders WHERE id = ?', id)!.status;

  test('rejects missing, wrong and stale signatures; order stays PENDING', async () => {
    const { order, providerRef } = await pendingOrder();
    const body = { eventId: 'e1', type: 'payment.succeeded', providerRef, amountCents: 1000 };
    const good = signWebhook(body);
    assert.equal((await post(good.raw, { 'content-type': 'application/json' })).statusCode, 401);
    const wrong = signWebhook(body, 'x'.repeat(48));
    assert.equal((await post(wrong.raw, wrong.headers)).statusCode, 401);
    const stale = signWebhook(body, undefined, Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await post(stale.raw, stale.headers)).statusCode, 401);
    // Tampered body with a valid signature of the original.
    const tampered = good.raw.replace('1000', '1');
    assert.equal((await post(tampered, good.headers)).statusCode, 401);
    assert.equal(status(order.id), 'PENDING');
  });

  test('replays are idempotent: one capture, one order.paid, one stock commit', async () => {
    const { order, providerRef } = await pendingOrder();
    const w = signWebhook({ eventId: 'replay-1', type: 'payment.succeeded', providerRef, amountCents: 1000 });
    assert.equal(json(await post(w.raw, w.headers)).duplicate, false);
    assert.equal(json(await post(w.raw, w.headers)).duplicate, true);
    assert.equal(status(order.id), 'PAID');
    const n = a.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE topic = 'order.paid' AND payload LIKE ?", `%${order.id}%`)!;
    assert.equal(n.n, 1);
  });

  test('amount mismatch is not captured', async () => {
    const { order, providerRef } = await pendingOrder();
    const w = signWebhook({ eventId: 'mismatch-1', type: 'payment.succeeded', providerRef, amountCents: 1 });
    assert.equal((await post(w.raw, w.headers)).statusCode, 200);
    assert.equal(status(order.id), 'PENDING');
  });

  test('malformed or unexpected payloads are rejected after authentication', async () => {
    const w = signWebhook({ eventId: 'x', type: 'payment.succeeded', providerRef: 'p', amountCents: 5, admin: true });
    assert.equal((await post(w.raw, w.headers)).statusCode, 400);
    const w2 = signWebhook({ eventId: 'x', type: 'refund.everything', providerRef: 'p' });
    assert.equal((await post(w2.raw, w2.headers)).statusCode, 400);
  });
});
