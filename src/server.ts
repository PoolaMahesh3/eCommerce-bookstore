import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const { app, bus, orders, payments } = await createApp(config, { logger: true });

// Background jobs: expire unpaid reservations, relay outbox events, retry refunds.
const timers = [
  setInterval(() => {
    try {
      orders.expireStale();
      bus.dispatch();
    } catch (e) {
      app.log.error({ err: e }, 'reservation expiry job failed');
    }
  }, 30_000),
  setInterval(() => {
    payments.processRefunds().catch((e: unknown) => app.log.error({ err: e }, 'refund job failed'));
  }, 60_000),
];
for (const t of timers) t.unref();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  for (const t of timers) clearInterval(t);
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
