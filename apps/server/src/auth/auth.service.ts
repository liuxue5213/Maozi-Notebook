import { and, eq, gt, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { newId } from '@ledgerone/domain';
import { db } from '../db/db';
import * as s from '../db/schema';
import { env } from '../env';
import { hashPassword, randomToken, sha256Hex, signJwt, verifyPassword } from '../common/crypto';
import { AppError } from '../common/errors';

const ACCESS_TTL_S = 2 * 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string | null; phone: string | null; nickname: string; baseCurrency: string };
}

@Injectable()
export class AuthService {
  async register(input: { email: string; password: string; nickname?: string }): Promise<TokenPair> {
    const email = input.email.trim().toLowerCase();
    const exists = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, email)).limit(1);
    if (exists.length) throw new AppError('auth.register.409', 409, '该邮箱已注册');
    const id = newId();
    const now = Date.now();
    await db.insert(s.users).values({
      id,
      email,
      password_hash: hashPassword(input.password),
      nickname: input.nickname?.trim() || email.split('@')[0],
      version_seq: 0,
      created_at: now,
      updated_at: now,
    });
    return this.issue(id);
  }

  async sendCode(phone: string): Promise<{ devCode?: string }> {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const now = Date.now();
    await db
      .insert(s.phone_codes)
      .values({ phone, code, expires_at: now + 10 * 60_000, used: false, created_at: now })
      .onConflictDoUpdate({ target: s.phone_codes.phone, set: { code, expires_at: now + 10 * 60_000, used: false } });
    // 生产环境接入短信通道(I01);仅开发态 DEV_MODE 直接返回(上线前全检 B2,生产由 env fail-fast 拒绝启动)
    return env.DEV_MODE && !env.IS_PROD ? { devCode: code } : {};
  }

  async login(input: { email?: string; password?: string; phone?: string; code?: string }): Promise<TokenPair> {
    if (input.email && input.password) {
      const u = (
        await db.select().from(s.users).where(eq(s.users.email, input.email.trim().toLowerCase())).limit(1)
      )[0];
      if (!u?.password_hash || !verifyPassword(input.password, u.password_hash)) {
        throw new AppError('auth.login.401', 401, '邮箱或密码错误');
      }
      return this.issue(u.id);
    }
    if (input.phone && input.code) {
      const c = (
        await db
          .select()
          .from(s.phone_codes)
          .where(and(eq(s.phone_codes.phone, input.phone), eq(s.phone_codes.code, input.code), eq(s.phone_codes.used, false), gt(s.phone_codes.expires_at, Date.now())))
          .limit(1)
      )[0];
      if (!c) throw new AppError('auth.code.401', 401, '验证码错误或已过期');
      await db.update(s.phone_codes).set({ used: true }).where(eq(s.phone_codes.phone, input.phone));
      let u = (await db.select().from(s.users).where(eq(s.users.phone, input.phone)).limit(1))[0];
      if (!u) {
        const id = newId();
        const now = Date.now();
        await db.insert(s.users).values({ id, phone: input.phone, nickname: `用户${input.phone.slice(-4)}`, version_seq: 0, created_at: now, updated_at: now });
        u = (await db.select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
      }
      return this.issue(u.id);
    }
    throw new AppError('auth.login.400', 400, '需提供邮箱密码或手机号验证码');
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const hash = sha256Hex(refreshToken);
    const row = (
      await db
        .select()
        .from(s.refresh_tokens)
        .where(and(eq(s.refresh_tokens.token_hash, hash), isNull(s.refresh_tokens.revoked_at), gt(s.refresh_tokens.expires_at, Date.now())))
        .limit(1)
    )[0];
    if (!row) throw new AppError('auth.refresh.401', 401, '刷新令牌无效或已过期');
    await db.update(s.refresh_tokens).set({ revoked_at: Date.now() }).where(eq(s.refresh_tokens.id, row.id));
    return this.issue(row.user_id);
  }

  async me(userId: string) {
    const u = (await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    if (!u) throw new AppError('auth.user.404', 404, '用户不存在');
    return this.publicUser(u);
  }

  private async issue(userId: string): Promise<TokenPair> {
    const u = (await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    if (!u) throw new AppError('auth.user.404', 404, '用户不存在');
    const refreshToken = randomToken();
    await db.insert(s.refresh_tokens).values({
      id: newId(),
      user_id: userId,
      token_hash: sha256Hex(refreshToken),
      expires_at: Date.now() + REFRESH_TTL_MS,
      created_at: Date.now(),
    });
    return { accessToken: signJwt({ sub: userId }, ACCESS_TTL_S), refreshToken, user: this.publicUser(u) };
  }

  private publicUser(u: typeof s.users.$inferSelect) {
    return { id: u.id, email: u.email, phone: u.phone, nickname: u.nickname, baseCurrency: u.base_currency };
  }
}
