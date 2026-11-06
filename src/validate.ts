import { badRequest } from './errors.ts';

export type Obj = Record<string, unknown>;

const bad = (msg: string) => badRequest('INVALID_INPUT', msg);

export function asObj(v: unknown, what = 'Request body'): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad(`${what} must be a JSON object`);
  return v as Obj;
}

/** Allowlist of accepted keys: unknown fields are rejected. */
export function allowKeys(o: Obj, keys: readonly string[]): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw bad(`Unknown field: ${k.slice(0, 40)}`);
  }
}

export function reqStr(o: Obj, k: string, min = 1, max = 255, trim = true): string {
  const v = o[k];
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  const s = trim ? v.trim() : v;
  if (s.length < min || s.length > max) throw bad(`${k} must be ${min}-${max} characters`);
  return s;
}

export function optStr(o: Obj, k: string, min = 1, max = 255): string | undefined {
  return o[k] === undefined ? undefined : reqStr(o, k, min, max);
}

export function reqInt(o: Obj, k: string, min: number, max: number): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw bad(`${k} must be an integer between ${min} and ${max}`);
  }
  return v;
}

export function optInt(o: Obj, k: string, min: number, max: number): number | undefined {
  return o[k] === undefined ? undefined : reqInt(o, k, min, max);
}

export function reqEnum<T extends string>(o: Obj, k: string, values: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw bad(`${k} must be one of: ${values.join(', ')}`);
  }
  return v as T;
}

export function reqEmail(o: Obj, k = 'email'): string {
  const s = reqStr(o, k, 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(`${k} is not a valid email address`);
  return s;
}

/** Path parameter holding a positive integer id. */
export function intParam(v: unknown, name = 'id'): number {
  if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) throw bad(`${name} must be a positive integer`);
  return Number(v);
}

export function uuidParam(v: unknown, name = 'id'): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw bad(`${name} must be a UUID`);
  }
  return v.toLowerCase();
}

export function queryStr(q: Obj, k: string, max = 100): string | undefined {
  const v = q[k];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw bad(`${k} is invalid`);
  return v;
}

export function queryInt(q: Obj, k: string, min: number, max: number): number | undefined {
  const v = queryStr(q, k, 15);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw bad(`${k} must be a non-negative integer`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(`${k} must be between ${min} and ${max}`);
  return n;
}

export function pageLimit(q: Obj): number {
  return queryInt(q, 'limit', 1, 50) ?? 20;
}

export function encodeCursor(o: object): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

export function decodeCursor(s: string | undefined): Obj | undefined {
  if (s === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return asObj(v, 'cursor');
  } catch {
    throw bad('cursor is invalid');
  }
}
