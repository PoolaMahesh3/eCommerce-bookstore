import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { isUniqueViolation, nowIso } from './db.ts';
import { hashPassword, verifyPassword } from './crypto.ts';
import { AppError, conflict, forbidden, notFound, unauthorized } from './errors.ts';
import { allowKeys, asObj, reqEmail, reqStr } from './validate.ts';

export const ROLES = ['customer', 'catalog_admin', 'order_admin', 'support', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const ISSUER = 'bookstore';
const AUDIENCE = 'bookstore-api';

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
}

export class AuthService {
  private secretKey: Uint8Array | undefined;
  private jwks: JWTVerifyGetKey | undefined;
  private dummyHash: Promise<string>;

  readonly config: Config;
  private db: Db;

  constructor(config: Config, db: Db) {
    this.config = config;
    this.db = db;
    // (fields assigned above)
    this.dummyHash = hashPassword('dummy-password-for-timing', config.passwordHashLogN);
    // OIDC verifies against the IdP's JWKS; otherwise the built-in HS256 secret is used.
    if (config.oidc) this.jwks = createRemoteJWKSet(new URL(config.oidc.jwksUrl), { timeoutDuration: 5000 });
    else this.secretKey = new TextEncoder().encode(config.jwtSecret);

  }

  get builtin(): boolean {
    return !this.config.oidc;
  }

  async issueToken(user: { id: string; role: Role }): Promise<string> {
    if (!this.secretKey) throw new Error('Token issuing disabled when OIDC is configured');
    return new SignJWT({ role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSec}s`)
      .sign(this.secretKey);
  }

  /** Validates signature, issuer, audience and expiry. Returns undefined for any invalid token. */
  async verifyToken(token: string): Promise<AuthUser | undefined> {
    try {
      if (this.config.oidc && this.jwks) {
        const { payload } = await jwtVerify(token, this.jwks, {
          issuer: this.config.oidc.issuer,
          audience: this.config.oidc.audience,
          algorithms: ['RS256', 'ES256', 'PS256'],
        });
        if (!payload.sub) return undefined;
        const claim = payload[this.config.oidc.roleClaim];
        const roles = Array.isArray(claim) ? claim : typeof claim === 'string' ? [claim] : [];
        const role = ROLES.find((r) => r !== 'customer' && roles.includes(r)) ?? 'customer';
        this.provision(payload.sub, typeof payload.email === 'string' ? payload.email : undefined, typeof payload.name === 'string' ? payload.name : undefined, role);
        return { id: payload.sub, role };
      }
      if (!this.secretKey) return undefined;
      const { payload } = await jwtVerify(token, this.secretKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const role = payload.role;
      if (!payload.sub || typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) return undefined;
      return { id: payload.sub, role: role as Role };
    } catch {
      return undefined;
    }
  }

  /** Just-in-time local profile for OIDC subjects (FKs reference users.id). */
  private provision(sub: string, email: string | undefined, name: string | undefined, role: Role): void {
    const existing = this.db.get<{ role: Role }>('SELECT role FROM users WHERE id = ?', sub);
    if (existing) {
      if (existing.role !== role) this.db.run('UPDATE users SET role = ? WHERE id = ?', role, sub);
      return;
    }
    try {
      this.db.run(
        'INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        sub,
        (email ?? `${sub}@oidc.invalid`).toLowerCase().slice(0, 254),
        (name ?? 'OIDC user').slice(0, 100),
        '!',
        role,
        nowIso(),
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }

  async register(email: string, name: string, password: string, role: Role = 'customer'): Promise<{ id: string }> {
    const id = randomUUID();
    const hash = await hashPassword(password, this.config.passwordHashLogN);
    try {
      this.db.run(
        'INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        email,
        name,
        hash,
        role,
        nowIso(),
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      throw e;
    }
    return { id };
  }

  async login(email: string, password: string): Promise<{ user: UserRow } | undefined> {
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
    // Always run one scrypt verification so response time doesn't reveal account existence.
    const ok = await verifyPassword(password, user?.password_hash ?? (await this.dummyHash));
    return user && ok ? { user } : undefined;
  }

  /** Create the bootstrap admin from environment on first start. */
  async seedAdmin(): Promise<void> {
    const { adminEmail, adminPassword } = this.config;
    if (!adminEmail || !adminPassword || !this.builtin) return;
    if (this.db.get('SELECT 1 AS x FROM users WHERE email = ?', adminEmail.toLowerCase())) return;
    if (adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    await this.register(adminEmail.toLowerCase(), 'Administrator', adminPassword, 'admin');
  }
}

export function registerAuth(app: FastifyInstance, auth: AuthService, db: Db): void {
  // Authenticate every request that presents a bearer token (authorization is enforced per route).
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header) return;
    const m = /^Bearer ([A-Za-z0-9\-_.]+)$/.exec(header);
    const user = m?.[1] ? await auth.verifyToken(m[1]) : undefined;
    if (!user) throw unauthorized();
    req.user = user;
  });

  if (!auth.builtin) return;

  app.post('/v1/auth/register', async (req, reply) => {
    const body = asObj(req.body);
    allowKeys(body, ['email', 'name', 'password']);
    const email = reqEmail(body);
    const name = reqStr(body, 'name', 1, 100);
    const password = reqStr(body, 'password', 12, 128, false);
    const { id } = await auth.register(email, name, password);
    req.log.info({ event: 'user_registered', userId: id }, 'user registered');
    return reply.code(201).send({ id, email, name });
  });

  app.post('/v1/auth/login', async (req) => {
    const body = asObj(req.body);
    allowKeys(body, ['email', 'password']);
    const email = reqEmail(body);
    const password = reqStr(body, 'password', 1, 128, false);
    const result = await auth.login(email, password);
    if (!result) {
      req.log.warn({ event: 'login_failed' }, 'failed login');
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    const token = await auth.issueToken({ id: result.user.id, role: result.user.role });
    req.log.info({ event: 'login_succeeded', userId: result.user.id }, 'login succeeded');
    return { accessToken: token, tokenType: 'Bearer', expiresIn: auth.config.accessTokenTtlSec };
  });

  app.get('/v1/me', async (req) => {
    const u = requireUser(req);
    const row = db.get<{ id: string; email: string; name: string; role: Role }>(
      'SELECT id, email, name, role FROM users WHERE id = ?',
      u.id,
    );
    if (!row) throw notFound('User');
    return row;
  });
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** RBAC check on every request. The `admin` role is a superset of all staff roles. */
export function requireRole(req: FastifyRequest, ...roles: Role[]): AuthUser {
  const u = requireUser(req);
  if (u.role !== 'admin' && !roles.includes(u.role)) {
    req.log.warn({ event: 'authz_denied', userId: u.id, role: u.role }, 'authorization denied');
    throw forbidden();
  }
  return u;
}
