import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { isUniqueViolation, nowIso } from './db.ts';
import type { EventBus } from './events.ts';
import { encrypt, hmacHex, randomToken, safeEqualHex } from './crypto.ts';
import { AppError, badRequest } from './errors.ts';
import { allowKeys, asObj, reqEnum, reqInt, reqStr } from './validate.ts';

export interface PaymentProvider {
  createIntent(i: { orderId: string; amountCents: number; currency: string }): Promise<{ providerRef: string; clientSecret: string }>;
  refund(providerRef: string, amountCents: number): Promise<void>;
}

/** Stand-in for Stripe/Adyen. The real provider tokenizes cards client-side, so card data never reaches us (PCI SAQ-A). */
export class SimulatedProvider implements PaymentProvider {
  async createIntent(): Promise<{ providerRef: string; clientSecret: string }> {
    const providerRef = `pi_${randomToken(12)}`;
    return { providerRef, clientSecret: `${providerRef}_secret_${randomToken(16)}` };
  }
  async refund(): Promise<void> {}
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const PROVIDER_TIMEOUT_MS = 5000;
const WEBHOOK_TOLERANCE_SEC = 300;

interface Logger {
  error(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

interface PaymentRow {
  id: string;
  order_id: string;
  provider_ref: string;
  status: string;
  amount_cents: number;
}

export class PaymentService {
  private config: Config;
  private db: Db;
  private bus: EventBus;
  private provider: PaymentProvider;
  private log: Logger;

  constructor(config: Config, db: Db, bus: EventBus, provider: PaymentProvider, log: Logger) {
    this.config = config;
    this.db = db;
    this.bus = bus;
    this.provider = provider;
    this.log = log;
  }

  async createIntent(orderId: string, amountCents: number, currency: string): Promise<{ providerRef: string; clientSecret: string }> {
    const intent = await withTimeout(this.provider.createIntent({ orderId, amountCents, currency }), PROVIDER_TIMEOUT_MS);
    const now = nowIso();
    this.db.run(
      `INSERT INTO payments (id, order_id, provider_ref, client_secret_enc, status, amount_cents, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'REQUIRES_PAYMENT', ?, ?, ?, ?)`,
      randomUUID(),
      orderId,
      intent.providerRef,
      encrypt(intent.clientSecret, this.config.dataKey),
      amountCents,
      currency,
      now,
      now,
    );
    return intent;
  }

  /** Provider webhook: authenticated by HMAC over timestamp + raw body, replay-protected, idempotent by event id. */
  handleWebhook(raw: string, timestamp: string | undefined, signature: string | undefined): { duplicate: boolean } {
    if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) throw this.badSignature();
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SEC) throw this.badSignature();
    const expected = hmacHex(this.config.webhookSecret, `${timestamp}.${raw}`);
    if (!safeEqualHex(expected, signature)) throw this.badSignature();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw badRequest('INVALID_INPUT', 'Body must be valid JSON');
    }
    const body = asObj(parsed);
    allowKeys(body, ['eventId', 'type', 'providerRef', 'amountCents']);
    const eventId = reqStr(body, 'eventId', 1, 100);
    const type = reqEnum(body, 'type', ['payment.succeeded', 'payment.failed'] as const);
    const providerRef = reqStr(body, 'providerRef', 1, 100);
    const amount = type === 'payment.succeeded' ? reqInt(body, 'amountCents', 1, 1_000_000_000) : 0;

    return this.db.tx(() => {
      try {
        this.db.run('INSERT INTO payment_events (event_id, received_at) VALUES (?, ?)', eventId, nowIso());
      } catch (e) {
        if (isUniqueViolation(e)) return { duplicate: true };
        throw e;
      }
      const p = this.db.get<PaymentRow>('SELECT id, order_id, provider_ref, status, amount_cents FROM payments WHERE provider_ref = ?', providerRef);
      if (!p) {
        this.log.warn({ event: 'webhook_unknown_payment' }, 'webhook for unknown payment ignored');
        return { duplicate: false };
      }
      if (type === 'payment.succeeded') {
        if (amount !== p.amount_cents) {
          this.log.error({ event: 'webhook_amount_mismatch', paymentId: p.id }, 'webhook amount mismatch; not captured');
          return { duplicate: false };
        }
        if (p.status === 'REQUIRES_PAYMENT' || p.status === 'FAILED') {
          this.setStatus(p.id, 'CAPTURED');
          this.bus.publish('payment.captured', { orderId: p.order_id, paymentId: p.id });
        }
      } else if (p.status === 'REQUIRES_PAYMENT') {
        this.setStatus(p.id, 'FAILED');
        this.bus.publish('payment.failed', { orderId: p.order_id, paymentId: p.id });
      }
      return { duplicate: false };
    });
  }

  setStatus(paymentId: string, status: string): void {
    this.db.run('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), paymentId);
  }

  /** Calls the provider for every payment awaiting refund; failures stay queued for the next run. */
  async processRefunds(): Promise<number> {
    const due = this.db.all<PaymentRow>("SELECT id, order_id, provider_ref, status, amount_cents FROM payments WHERE status = 'NEEDS_REFUND'");
    let done = 0;
    for (const p of due) {
      try {
        await withTimeout(this.provider.refund(p.provider_ref, p.amount_cents), PROVIDER_TIMEOUT_MS);
        this.setStatus(p.id, 'REFUNDED');
        done++;
      } catch {
        this.log.error({ event: 'refund_failed', paymentId: p.id }, 'refund failed; will retry');
      }
    }
    return done;
  }

  private badSignature(): AppError {
    this.log.warn({ event: 'webhook_bad_signature' }, 'webhook rejected');
    return new AppError(401, 'INVALID_SIGNATURE', 'Invalid signature');
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function registerPayments(app: FastifyInstance, payments: PaymentService, bus: EventBus): void {
  app.post('/v1/payments/webhook', async (req) => {
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return typeof v === 'string' ? v : undefined;
    };
    const result = payments.handleWebhook(req.rawBody ?? '', header('x-webhook-timestamp'), header('x-webhook-signature'));
    bus.dispatch();
    await payments.processRefunds();
    return { received: true, duplicate: result.duplicate };
  });
}
