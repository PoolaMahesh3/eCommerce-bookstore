// Generates random secrets for local development: `npm run gen-env > .env`
import { randomBytes } from 'node:crypto';

const b64 = (n: number): string => randomBytes(n).toString('base64');
const url = (n: number): string => randomBytes(n).toString('base64url');

console.log(`# Generated ${new Date().toISOString()} - never commit this file
HOST=127.0.0.1
PORT=8080
DB_PATH=bookstore.db
JWT_SECRET=${url(48)}
WEBHOOK_SECRET=${url(48)}
DATA_KEY=${b64(32)}
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=${url(18)}
`);
