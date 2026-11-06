import { createHmac, randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { PaymentProvider } from '../src/payments.ts';

export const ENV = {
  DB_PATH: ':memory:',
  JWT_SECRET: 'j'.repeat(48),
  WEBHOOK_SECRET: 'w'.repeat(48),
  DATA_KEY: randomBytes(32).toString('base64'),
  PASSWORD_HASH_LOG_N: '10',
  RATE_LIMIT_PER_MIN: '100000',
  AUTH_RATE_LIMIT_PER_MIN: '100000',
  RESERVATION_TTL_SEC: '900',
};

export async function makeApp(extra: Record<string, string> = {}, provider?: PaymentProvider): Promise<App> {
  const config = loadConfig({ ...ENV, ...extra });
  const a = await createApp(config, provider ? { provider } : {});
  await a.app.ready();
  return a;
}

export function isbn(n: number): string {
  const base = `978${String(n).padStart(9, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  return base + String((10 - (sum % 10)) % 10);
}

let counter = 0;

export interface Session {
  id: string;
  token: string;
  email: string;
}

export async function signup(a: App, role: 'customer' | 'catalog_admin' | 'order_admin' | 'support' = 'customer'): Promise<Session> {
  const email = `user${++counter}-${randomBytes(3).toString('hex')}@example.com`;
  const password = 'correct horse battery staple';
  let id: string;
  if (role === 'customer') {
    const r = await a.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, name: 'Test User', password } });
    if (r.statusCode !== 201) throw new Error(`register failed: ${r.body}`);
    id = (r.json() as { id: string }).id;
  } else {
    id = (await a.auth.register(email, 'Staff', password, role)).id;
  }
  const l = await a.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  if (l.statusCode !== 200) throw new Error(`login failed: ${l.body}`);
  return { id, token: (l.json() as { accessToken: string }).accessToken, email };
}

export const bearer = (s: Session): Record<string, string> => ({ authorization: `Bearer ${s.token}` });

export async function createBook(a: App, admin: Session, opts: { title?: string; stock?: number; price?: number; format?: string; n?: number; category?: string } = {}) {
  const n = opts.n ?? ++counter + 1000;
  const r = await a.app.inject({
    method: 'POST',
    url: '/v1/admin/books',
    headers: bearer(admin),
    payload: {
      title: opts.title ?? `Book ${n}`,
      author: 'Ada Author',
      description: 'A fine book about distributed systems',
      category: opts.category ?? 'Technology',
      editions: [{ isbn13: isbn(n), format: opts.format ?? 'paperback', priceCents: opts.price ?? 2000, currency: 'USD', initialStock: opts.stock ?? 10 }],
    },
  });
  if (r.statusCode !== 201) throw new Error(`createBook failed: ${r.body}`);
  const book = r.json() as { id: number; editions: { id: number }[] };
  return { bookId: book.id, editionId: book.editions[0]!.id };
}

export const addToCart = (a: App, s: Session, editionId: number, qty = 1) =>
  a.app.inject({ method: 'PUT', url: `/v1/cart/items/${editionId}`, headers: bearer(s), payload: { qty } });

export const ADDRESS = { name: 'Test User', line1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US' };

let keyCounter = 0;
export const newKey = (): string => `key-${Date.now()}-${++keyCounter}-${randomBytes(4).toString('hex')}`;

export const checkout = (a: App, s: Session, body: object = { shippingAddress: ADDRESS }, key = newKey()) =>
  a.app.inject({ method: 'POST', url: '/v1/checkout', headers: { ...bearer(s), 'idempotency-key': key }, payload: body });

export function signWebhook(body: object, secret = ENV.WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return { raw, headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': sig } };
}

let evt = 0;
export async function pay(a: App, orderId: string, outcome: 'payment.succeeded' | 'payment.failed' = 'payment.succeeded', eventId = `evt_${Date.now()}_${++evt}`) {
  const p = a.db.get<{ provider_ref: string; amount_cents: number }>('SELECT provider_ref, amount_cents FROM payments WHERE order_id = ?', orderId);
  if (!p) throw new Error('no payment');
  const body = outcome === 'payment.succeeded'
    ? { eventId, type: outcome, providerRef: p.provider_ref, amountCents: p.amount_cents }
    : { eventId, type: outcome, providerRef: p.provider_ref };
  const { raw, headers } = signWebhook(body);
  return a.app.inject({ method: 'POST', url: '/v1/payments/webhook', headers, payload: raw });
}

export const stock = (a: App, editionId: number): { on_hand: number; reserved: number } => {
  const r = a.db.get<{ on_hand: number; reserved: number }>('SELECT on_hand, reserved FROM stock WHERE edition_id = ?', editionId)!;
  return { on_hand: r.on_hand, reserved: r.reserved };
};
