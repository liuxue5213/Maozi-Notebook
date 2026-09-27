import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const h = scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${h}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, h] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const calc = scryptSync(pw, salt, 64);
  const expect = Buffer.from(h, 'hex');
  return calc.length === expect.length && timingSafeEqual(calc, expect);
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256Hex(s: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(s).digest('hex');
}

// ---------- JWT(HS256,自实现避免额外依赖) ----------

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function sign(data: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(data).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signJwt(payload: Record<string, unknown>, expiresInSeconds: number): string {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds, iat: Math.floor(Date.now() / 1000) });
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

export function verifyJwt<T = Record<string, unknown>>(token: string): T {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const [header, body, sig] = parts;
  const expect = sign(`${header}.${body}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature');
  const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) throw new Error('expired');
  return payload as T;
}
