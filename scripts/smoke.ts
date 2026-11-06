// Live smoke test: starts the real server process on a socket and exercises it over HTTP.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';

const port = 18080;
const db = `smoke-${randomBytes(3).toString('hex')}.db`;
const env = {
  ...process.env,
  PORT: String(port),
  DB_PATH: db,
  JWT_SECRET: randomBytes(32).toString('base64url'),
  WEBHOOK_SECRET: randomBytes(32).toString('base64url'),
  DATA_KEY: randomBytes(32).toString('base64'),
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'smoke-test-admin-password',
  LOG_LEVEL: 'warn',
};
const child = spawn(process.execPath, ['src/server.ts'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
const base = `http://127.0.0.1:${port}`;

async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

try {
  await waitUp();
  const login = await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'smoke-test-admin-password' }) })).json() as { accessToken: string };
  const h = { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` };
  const created = await fetch(`${base}/v1/admin/books`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Smoke Book', author: 'Tester', category: 'Test', editions: [{ isbn13: '9780306406157', format: 'paperback', priceCents: 1999, currency: 'USD', initialStock: 3 }] }) });
  const search = await (await fetch(`${base}/v1/books?query=smoke`)).json() as { items: unknown[] };
  console.log('health:', (await fetch(`${base}/healthz`)).status, '| create:', created.status, '| search hits:', search.items.length);
  const hdr = (await fetch(`${base}/healthz`)).headers;
  console.log('headers:', hdr.get('x-content-type-options'), hdr.get('cache-control'));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const s of ['', '-wal', '-shm']) rmSync(`${db}${s}`, { force: true });
}
