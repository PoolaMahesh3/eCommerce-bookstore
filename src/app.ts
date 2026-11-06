import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import { EventBus } from './events.ts';
import { AuthService, registerAuth } from './auth.ts';
import { registerRateLimit } from './ratelimit.ts';
import { CatalogService, registerCatalog } from './catalog.ts';
import { PricingService, registerCart } from './cart.ts';
import { InventoryService } from './inventory.ts';
import { PaymentService, SimulatedProvider, registerPayments } from './payments.ts';
import type { PaymentProvider } from './payments.ts';
import { OrderService, registerOrders } from './orders.ts';
import { registerDigitalAndNotifications, registerFulfillment } from './fulfillment.ts';
import { registerReviews } from './reviews.ts';
import { AppError } from './errors.ts';
import { registerWeb } from './web.ts';

export interface App {
  app: FastifyInstance;
  db: Db;
  bus: EventBus;
  orders: OrderService;
  payments: PaymentService;
  catalog: CatalogService;
  auth: AuthService;
}

export interface AppOptions {
  logger?: boolean;
  provider?: PaymentProvider;
}

export async function createApp(config: Config, opts: AppOptions = {}): Promise<App> {
  const tls =
    config.tlsCertFile && config.tlsKeyFile
      ? { https: { key: readFileSync(config.tlsKeyFile), cert: readFileSync(config.tlsCertFile), minVersion: 'TLSv1.2' as const } }
      : {};

  const app = Fastify({
    ...tls,
    logger: opts.logger
      ? {
          level: config.logLevel,
          redact: ['req.headers.authorization', 'req.headers["x-webhook-signature"]', 'req.headers.cookie'],
          serializers: {
            // Download tokens live in the path: never log them.
            req: (r) => ({ method: r.method, url: r.url.replace(/^\/v1\/downloads\/[^/?]+/, '/v1/downloads/[redacted]'), id: r.id }),
          },
        }
      : false,
    genReqId: () => randomUUID(),
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
    keepAliveTimeout: 10_000,
  });

  // Keep the raw body: webhook signatures are computed over the exact bytes received.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    if (raw === '') return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new AppError(400, 'INVALID_JSON', 'Body must be valid JSON'), undefined);
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Generic client errors with a trace id; details go to server logs only.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ code: err.code, message: err.message, traceId: req.id });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INVALID_REQUEST';
      const message = status === 413 ? 'Payload too large' : status === 415 ? 'Unsupported media type' : 'Invalid request';
      return reply.code(status).send({ code, message, traceId: req.id });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'INTERNAL', message: 'Internal server error', traceId: req.id });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found', traceId: req.id }));

  registerRateLimit(app, config);

  const db = new Db(config.dbPath);
  const bus = new EventBus(db, app.log);
  const auth = new AuthService(config, db);
  const catalog = new CatalogService(db);
  const pricing = new PricingService(db);
  const inventory = new InventoryService(db);
  const payments = new PaymentService(config, db, bus, opts.provider ?? new SimulatedProvider(), app.log);
  const orders = new OrderService(config, db, bus, pricing, inventory, payments, app.log);
  registerFulfillment(bus, db);

  registerAuth(app, auth, db);
  registerCatalog(app, catalog, db);
  registerCart(app, db, pricing);
  registerOrders(app, orders);
  registerPayments(app, payments, bus);
  registerDigitalAndNotifications(app, db, config);
  registerReviews(app, db);

  registerWeb(app);
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    db.get('SELECT 1 AS ok');
    return { status: 'ready' };
  });

  app.addHook('onClose', async () => db.close());
  await auth.seedAdmin();
  return { app, db, bus, orders, payments, catalog, auth };
}
