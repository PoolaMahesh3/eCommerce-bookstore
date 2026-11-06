import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Strict CSP for the storefront: same-origin scripts/styles only, no inline code.
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/** Serves the static storefront from ./public (fixed allowlist of files, read once at startup). */
export function registerWeb(app: FastifyInstance): void {
  const dir = join(import.meta.dirname, '..', 'public');
  for (const [route, { file, type }] of Object.entries(FILES)) {
    const body = readFileSync(join(dir, file));
    app.get(route, async (_req, reply) => reply.header('Content-Type', type).header('Content-Security-Policy', PAGE_CSP).send(body));
  }
}
