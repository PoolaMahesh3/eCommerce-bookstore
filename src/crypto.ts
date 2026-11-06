import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

function scryptAsync(password: string, salt: Buffer, keylen: number, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r: 8, p: 1, maxmem: 512 * N * 8 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Password hash format: scrypt$logN$saltB64$hashB64 */
export async function hashPassword(password: string, logN: number): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, 2 ** logN);
  return `scrypt$${logN}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const logN = Number(parts[1]);
  if (!Number.isInteger(logN) || logN < 10 || logN > 20) return false;
  const expected = Buffer.from(parts[3] ?? '', 'base64');
  const key = await scryptAsync(password, Buffer.from(parts[2] ?? '', 'base64'), expected.length, 2 ** logN);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** AES-256-GCM. Output: v1.ivB64.tagB64.ctB64 */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(blob: string, key: Buffer): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const hmacHex = (secret: string, data: string): string => createHmac('sha256', secret).update(data).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
