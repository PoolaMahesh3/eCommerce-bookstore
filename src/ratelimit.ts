import type { FastifyInstance } from 'fastify';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';

interface Bucket {
  windowStart: number;
  count: number;
}

const WINDOW_MS = 60_000;
const MAX_KEYS = 100_000;

/** Fixed-window per-IP limiter (in production: enforced at the gateway / backed by Redis). */
export function registerRateLimit(app: FastifyInstance, config: Config): void {
  const buckets = new Map<string, Bucket>();

  app.addHook('onRequest', async (req, reply) => {
    const isAuth = req.url.startsWith('/v1/auth/');
    const limit = isAuth ? config.authRateLimitPerMin : config.rateLimitPerMin;
    const key = `${isAuth ? 'auth' : 'api'}:${req.ip}`;
    const now = Date.now();

    if (buckets.size > MAX_KEYS) {
      for (const [k, b] of buckets) if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
      if (buckets.size > MAX_KEYS) buckets.clear();
    }

    let b = buckets.get(key);
    if (!b || now - b.windowStart >= WINDOW_MS) {
      b = { windowStart: now, count: 0 };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > limit) {
      const retry = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000));
      reply.header('Retry-After', String(retry));
      req.log.warn({ event: 'rate_limited', bucket: isAuth ? 'auth' : 'api' }, 'rate limit exceeded');
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests');
    }
  });
}
