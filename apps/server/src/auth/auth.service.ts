import { and, eq, gt, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { newId } from '@ledgerone/domain';
import { db } from '../db/db';
import * as s from '../db/schema';
import { env } from '../env';
import { hashPassword, randomToken, sha256Hex, signJwt, verifyPassword } from '../common/crypto';
import { AppError } from '../common/errors';
import { logAudit, maskEmail, maskPhone } from '../common/audit';

const ACCESS_TTL_S = 2 * 60 * 60;
const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 上线全检 F-08:30 天 → 14 天
const CODE_TTL_MS = 10 * 60_000;
const CODE_RESEND_COOLDOWN_MS = 60_000; // F-07:60s 冷却
const CODE_MAX_ATTEMPTS = 5; // F-06:连续失败 5 次锁定
const CODE_LOCK_MS = 15 * 60_000; // F-06:锁定 15 分钟(锁定期内禁止校验与重发)

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
      password_hash: await hashPassword(input.password),
      nickname: input.nickname?.trim() || email.split('@')[0],
      version_seq: 0,
      created_at: now,
      updated_at: now,
    });
    return this.issue(id);
  }

  /** 验证码摘要:与手机号绑定(防跨号撞库),库中只存 HMAC 摘要不存明文(F-06) */
  private codeDigest(phone: string, code: string): string {
    return createHmac('sha256', env.JWT_SECRET).update(`${phone}:${code}`).digest('hex');
  }

  /**
   * 发送验证码(F-06/F-07):CSPRNG(randomInt)生成,库中只存 HMAC 摘要。
   * 两道闸门(顺序不能反,否则「5 次锁定」会被 60s 重发架空):
   * 1) locked_until 未过 → 拒绝(锁定期内既不许校验也不许重发);
   * 2) 60s 冷却内拒绝重发。
   * 重发只在**非锁定**状态下重置失败计数,且不清 locked_until(避免重发解锁)。
   * 生产接入真实短信通道(I01),开发态 DEV_MODE 直接返回便于联调。
   */
  async sendCode(phone: string): Promise<{ devCode?: string }> {
    const now = Date.now();
    const last = (await db.select().from(s.phone_codes).where(eq(s.phone_codes.phone, phone)).limit(1))[0];
    if (last && Number(last.locked_until) > now) {
      logAudit({ action: 'auth.code.send_locked', target: maskPhone(phone), summary: { lockedUntil: Number(last.locked_until) } });
      throw new AppError('auth.code.423', 423, `尝试次数过多,请 ${Math.ceil((Number(last.locked_until) - now) / 60_000)} 分钟后再试`);
    }
    if (last && now - Number(last.last_sent_at) < CODE_RESEND_COOLDOWN_MS) {
      throw new AppError('auth.code.429', 429, '发送过于频繁,请 60 秒后再试');
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = this.codeDigest(phone, code);
    await db
      .insert(s.phone_codes)
      .values({ phone, code_hash: codeHash, attempts: 0, last_sent_at: now, expires_at: now + CODE_TTL_MS, used: false, created_at: now })
      .onConflictDoUpdate({
        target: s.phone_codes.phone,
        // 不写 locked_until:重发不得清除已有的锁定
        set: { code_hash: codeHash, attempts: 0, last_sent_at: now, expires_at: now + CODE_TTL_MS, used: false },
      });
    return env.DEV_MODE && !env.IS_PROD ? { devCode: code } : {};
  }

  async login(input: { email?: string; password?: string; phone?: string; code?: string }): Promise<TokenPair> {
    if (input.email && input.password) {
      const u = (
        await db.select().from(s.users).where(eq(s.users.email, input.email.trim().toLowerCase())).limit(1)
      )[0];
      if (!u?.password_hash || !(await verifyPassword(input.password, u.password_hash))) {
        logAudit({ action: 'auth.login.failed', target: maskEmail(input.email.trim().toLowerCase()), summary: { reason: 'bad_credentials' } });
        throw new AppError('auth.login.401', 401, '邮箱或密码错误');
      }
      return this.issue(u.id);
    }
    if (input.phone && input.code) {
      const now = Date.now();
      const rec = (
        await db.select().from(s.phone_codes).where(eq(s.phone_codes.phone, input.phone)).limit(1)
      )[0];
      if (!rec) throw new AppError('auth.code.401', 401, '验证码错误或已过期');
      // 锁定期内直接拒绝校验:否则「每 60s 重发一次」就能把 5 次锁定架空成 60s 锁定(F-06 核心)
      if (Number(rec.locked_until) > now) {
        logAudit({ action: 'auth.code.locked', target: maskPhone(input.phone), summary: { phase: 'verify_refused' } });
        throw new AppError('auth.code.423', 423, `尝试次数过多,请 ${Math.ceil((Number(rec.locked_until) - now) / 60_000)} 分钟后再试`);
      }
      const expect = Buffer.from(this.codeDigest(input.phone, input.code), 'hex');
      const got = Buffer.from(rec.code_hash, 'hex');
      const ok = expect.length === got.length && timingSafeEqual(expect, got);
      if (!ok || rec.used || now > Number(rec.expires_at)) {
        const attempts = rec.attempts + 1;
        const lock = attempts >= CODE_MAX_ATTEMPTS ? now + CODE_LOCK_MS : Number(rec.locked_until);
        await db
          .update(s.phone_codes)
          .set({ attempts, locked_until: lock })
          .where(eq(s.phone_codes.phone, input.phone));
        logAudit({ action: 'auth.code.verify_failed', target: maskPhone(input.phone), summary: { attempts } });
        if (lock > now) {
          logAudit({ action: 'auth.code.locked', target: maskPhone(input.phone), summary: { phase: 'lock_created', attempts } });
          throw new AppError('auth.code.423', 423, `尝试次数过多,请 ${Math.ceil((lock - now) / 60_000)} 分钟后再试`);
        }
        throw new AppError('auth.code.401', 401, '验证码错误或已过期');
      }
      // 校验成功:清零失败计数与锁定,并一次性消费
      await db
        .update(s.phone_codes)
        .set({ used: true, attempts: 0, locked_until: 0 })
        .where(eq(s.phone_codes.phone, input.phone));
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
    if (!row) {
      logAudit({ action: 'auth.refresh.failed', target: 'invalid_or_expired_token' });
      throw new AppError('auth.refresh.401', 401, '刷新令牌无效或已过期');
    }
    // 轮换语义:旧 token 立即吊销,一次性换新(留痕供盗用排查)
    await db.update(s.refresh_tokens).set({ revoked_at: Date.now() }).where(eq(s.refresh_tokens.id, row.id));
    logAudit({ actorUserId: row.user_id, action: 'auth.refresh.rotated' });
    return this.issue(row.user_id);
  }

  /** 全端下线(F-08):吊销该用户全部 refresh token(丢设备/改密码后亦可复用) */
  async revokeAllSessions(userId: string): Promise<void> {
    await db
      .update(s.refresh_tokens)
      .set({ revoked_at: Date.now() })
      .where(and(eq(s.refresh_tokens.user_id, userId), isNull(s.refresh_tokens.revoked_at)));
    logAudit({ actorUserId: userId, action: 'auth.logout' });
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
