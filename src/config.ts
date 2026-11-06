export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  roleClaim: string;
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Present only when OIDC is not configured (built-in dev login). */
  jwtSecret: string | undefined;
  oidc: OidcConfig | undefined;
  dataKey: Buffer;
  webhookSecret: string;
  adminEmail: string | undefined;
  adminPassword: string | undefined;
  accessTokenTtlSec: number;
  reservationTtlSec: number;
  downloadLinkTtlSec: number;
  rateLimitPerMin: number;
  authRateLimitPerMin: number;
  passwordHashLogN: number;
  logLevel: string;
  trustProxy: boolean;
  tlsCertFile: string | undefined;
  tlsKeyFile: string | undefined;
}

function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: expected integer in [${min}, ${max}]`);
  }
  return n;
}

function secret(env: NodeJS.ProcessEnv, name: string, minLen: number): string {
  const v = env[name];
  if (!v || v.length < minLen) {
    throw new Error(`${name} is required and must be at least ${minLen} characters (set it via environment)`);
  }
  return v;
}

function loadOidc(env: NodeJS.ProcessEnv): OidcConfig | undefined {
  const { OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URL } = env;
  if (!OIDC_ISSUER && !OIDC_AUDIENCE && !OIDC_JWKS_URL) return undefined;
  if (!OIDC_ISSUER || !OIDC_AUDIENCE || !OIDC_JWKS_URL) {
    throw new Error('OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URL must all be set together');
  }
  // Security policy: HTTPS only for external calls.
  if (new URL(OIDC_JWKS_URL).protocol !== 'https:') throw new Error('OIDC_JWKS_URL must use https');
  return { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE, jwksUrl: OIDC_JWKS_URL, roleClaim: env.OIDC_ROLE_CLAIM ?? 'roles' };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST ?? '127.0.0.1';
  // Security policy: never bind to all interfaces.
  if (host === '' || host === '0.0.0.0' || host === '::' || host === '[::]') {
    throw new Error('HOST must be loopback or a specific internal address, not a wildcard address');
  }
  const dataKey = Buffer.from(env.DATA_KEY ?? '', 'base64');
  if (dataKey.length !== 32) {
    throw new Error('DATA_KEY is required and must be 32 bytes, base64-encoded (AES-256)');
  }
  const oidc = loadOidc(env);
  return {
    host,
    port: int(env, 'PORT', 8080, 1, 65535),
    dbPath: env.DB_PATH ?? 'bookstore.db',
    oidc,
    jwtSecret: oidc ? undefined : secret(env, 'JWT_SECRET', 32),
    dataKey,
    webhookSecret: secret(env, 'WEBHOOK_SECRET', 32),
    adminEmail: env.ADMIN_EMAIL || undefined,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    accessTokenTtlSec: int(env, 'ACCESS_TOKEN_TTL_SEC', 900, 60, 86400),
    reservationTtlSec: int(env, 'RESERVATION_TTL_SEC', 900, 1, 86400),
    downloadLinkTtlSec: int(env, 'DOWNLOAD_LINK_TTL_SEC', 300, 10, 3600),
    rateLimitPerMin: int(env, 'RATE_LIMIT_PER_MIN', 300, 1, 1_000_000),
    authRateLimitPerMin: int(env, 'AUTH_RATE_LIMIT_PER_MIN', 10, 1, 1_000_000),
    passwordHashLogN: int(env, 'PASSWORD_HASH_LOG_N', 17, 10, 20),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: env.TRUST_PROXY === 'true',
    tlsCertFile: env.TLS_CERT_FILE || undefined,
    tlsKeyFile: env.TLS_KEY_FILE || undefined,
  };
}
