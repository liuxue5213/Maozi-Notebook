import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { newId, SUPPORTED_CURRENCIES } from '@ledgerone/domain';
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
const LOGIN_MAX_ATTEMPTS = 5; // P1-11:邮箱登录按账号 5 次失败锁定(同 F-06 语义)
const LOGIN_LOCK_MS = 15 * 60_000;

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
      const email = input.email.trim().toLowerCase();
      // P1-11:按账号失败锁定(全局限流按 IP,挡不住多 IP 针对单账号撞库)
      const now = Date.now();
      const lock = (await db.select().from(s.login_locks).where(eq(s.login_locks.email, email)).limit(1))[0];
      if (lock && Number(lock.locked_until) > now) {
        logAudit({ action: 'auth.login.locked', target: maskEmail(email), summary: { phase: 'refused' } });
        throw new AppError('auth.login.423', 423, `尝试次数过多,请 ${Math.ceil((Number(lock.locked_until) - now) / 60_000)} 分钟后再试`);
      }
      const u = (await db.select().from(s.users).where(eq(s.users.email, email)).limit(1))[0];
      if (!u?.password_hash || !(await verifyPassword(input.password, u.password_hash))) {
        // 原子自增失败计数,达阈值写锁定(与 F-06 验证码同语义)
        const t = Date.now();
        const rows = await db
          .update(s.login_locks)
          .set({
            attempts: sql`${s.login_locks.attempts} + 1`,
            locked_until: sql`CASE WHEN ${s.login_locks.attempts} + 1 >= ${LOGIN_MAX_ATTEMPTS} THEN ${t + LOGIN_LOCK_MS} ELSE ${s.login_locks.locked_until} END`,
            updated_at: t,
          })
          .where(eq(s.login_locks.email, email))
          .returning({ attempts: s.login_locks.attempts, locked_until: s.login_locks.locked_until });
        const cur =
          rows[0] ??
          (
            await db
              .insert(s.login_locks)
              .values({ email, attempts: 1, locked_until: 0, updated_at: t })
              .onConflictDoUpdate({ target: s.login_locks.email, set: { attempts: 1, updated_at: t } })
              .returning({ attempts: s.login_locks.attempts, locked_until: s.login_locks.locked_until })
          )[0];
        logAudit({ action: 'auth.login.failed', target: maskEmail(email), summary: { reason: 'bad_credentials', attempts: cur?.attempts ?? 1 } });
        if (Number(cur?.locked_until ?? 0) > t) {
          logAudit({ action: 'auth.login.locked', target: maskEmail(email), summary: { phase: 'lock_created', attempts: cur?.attempts } });
          throw new AppError('auth.login.423', 423, '尝试次数过多,请 15 分钟后再试');
        }
        throw new AppError('auth.login.401', 401, '邮箱或密码错误');
      }
      // 成功登录:清失败计数
      await db.delete(s.login_locks).where(eq(s.login_locks.email, email));
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
        // P1-12:失败计数改为单条原子 UPDATE 自增(修复前 JS 读-改-写,并发可绕过 5 次锁定)
        const rows = await db
          .update(s.phone_codes)
          .set({
            attempts: sql`${s.phone_codes.attempts} + 1`,
            locked_until: sql`CASE WHEN ${s.phone_codes.attempts} + 1 >= ${CODE_MAX_ATTEMPTS} THEN ${now + CODE_LOCK_MS} ELSE ${s.phone_codes.locked_until} END`,
          })
          .where(eq(s.phone_codes.phone, input.phone))
          .returning({ attempts: s.phone_codes.attempts, locked_until: s.phone_codes.locked_until });
        const attempts = rows[0]?.attempts ?? rec.attempts + 1;
        const lock = Number(rows[0]?.locked_until ?? rec.locked_until);
        logAudit({ action: 'auth.code.verify_failed', target: maskPhone(input.phone), summary: { attempts } });
        if (lock > now) {
          logAudit({ action: 'auth.code.locked', target: maskPhone(input.phone), summary: { phase: 'lock_created', attempts } });
          throw new AppError('auth.code.423', 423, `尝试次数过多,请 ${Math.ceil((lock - now) / 60_000)} 分钟后再试`);
        }
        throw new AppError('auth.code.401', 401, '验证码错误或已过期');
      }
      // 校验成功:一次性消费(P1-12:条件更新 used=false → 已用即拒绝,并发重放只有一方成功)
      const consumed = await db
        .update(s.phone_codes)
        .set({ used: true, attempts: 0, locked_until: 0 })
        .where(and(eq(s.phone_codes.phone, input.phone), eq(s.phone_codes.used, false)))
        .returning({ phone: s.phone_codes.phone });
      if (!consumed.length) {
        logAudit({ action: 'auth.code.replay', target: maskPhone(input.phone) });
        throw new AppError('auth.code.401', 401, '验证码已使用');
      }
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
    // P1-13:先查吊销/过期外的有效行;查不到时再看「该 token 是否存在但已被吊销」——
    // 已轮换 token 的重放是盗用强信号 → 吊销该用户全部会话(token 家族连坐),逼迫重新登录
    const row = (
      await db
        .select()
        .from(s.refresh_tokens)
        .where(and(eq(s.refresh_tokens.token_hash, hash), isNull(s.refresh_tokens.revoked_at), gt(s.refresh_tokens.expires_at, Date.now())))
        .limit(1)
    )[0];
    if (!row) {
      const replayed = (await db.select({ id: s.refresh_tokens.id, user_id: s.refresh_tokens.user_id }).from(s.refresh_tokens).where(eq(s.refresh_tokens.token_hash, hash)).limit(1))[0];
      if (replayed) {
        await db
          .update(s.refresh_tokens)
          .set({ revoked_at: Date.now() })
          .where(and(eq(s.refresh_tokens.user_id, replayed.user_id), isNull(s.refresh_tokens.revoked_at)));
        logAudit({ actorUserId: replayed.user_id, action: 'auth.refresh.reuse_detected', summary: { familyRevoked: true } });
      } else {
        logAudit({ action: 'auth.refresh.failed', target: 'invalid_or_expired_token' });
      }
      throw new AppError('auth.refresh.401', 401, '刷新令牌无效或已过期');
    }
    // 轮换语义:条件更新吊销(P1-13:rowCount=0 即并发已轮换 → 按重放处理连坐),一次性换新
    const rotated = await db
      .update(s.refresh_tokens)
      .set({ revoked_at: Date.now() })
      .where(and(eq(s.refresh_tokens.id, row.id), isNull(s.refresh_tokens.revoked_at)))
      .returning({ id: s.refresh_tokens.id });
    if (!rotated.length) {
      await db
        .update(s.refresh_tokens)
        .set({ revoked_at: Date.now() })
        .where(and(eq(s.refresh_tokens.user_id, row.user_id), isNull(s.refresh_tokens.revoked_at)));
      logAudit({ actorUserId: row.user_id, action: 'auth.refresh.reuse_detected', summary: { familyRevoked: true, race: true } });
      throw new AppError('auth.refresh.401', 401, '刷新令牌无效或已过期');
    }
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

  /**
   * 注销账号(P0-6,第 28 轮):验证密码 → 软删身份与数据足迹 → 吊销全部会话。
   * 范围(PRD 10.2「注销」最小合规语义):
   * - users.status='deleted',email/phone 置空(释放唯一键,允许重新注册);密码哈希清空;
   * - 该用户的 ledger_members 行软删;其 **拥有的** 账本软删(数据保留 30 天随 purge 硬删);
   * - 全部 refresh token 吊销;
   * - 共享账本中该用户创建的流水保留(数据归属账本,不因成员注销而消失)。
   */
  async deleteAccount(userId: string, password: string): Promise<{ deleted: true }> {
    const u = (await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    if (!u || !u.password_hash || !(await verifyPassword(password, u.password_hash))) {
      logAudit({ actorUserId: userId, action: 'auth.delete.failed', summary: { reason: 'bad_credentials' } });
      throw new AppError('auth.delete.403', 403, '密码验证失败,未注销');
    }
    const now = Date.now();
    await db.transaction(async (tx: any) => {
      // 成员行软删(非拥有账本的成员资格终止)
      const memberships = await tx
        .select({ id: s.ledger_members.id })
        .from(s.ledger_members)
        .where(and(eq(s.ledger_members.user_id, userId), eq(s.ledger_members.is_deleted, false)));
      for (const m of memberships) {
        await tx.update(s.ledger_members).set({ is_deleted: true, deleted_at: now, updated_at: now }).where(eq(s.ledger_members.id, m.id));
      }
      // 拥有的账本软删(与 ledger.service.remove 同语义;账本内数据保留至 purge)
      const owned = await tx
        .select({ id: s.ledgers.id })
        .from(s.ledgers)
        .where(and(eq(s.ledgers.owner_user_id, userId), eq(s.ledgers.is_deleted, false)));
      for (const l of owned) {
        await tx.update(s.ledgers).set({ is_deleted: true, deleted_at: now, updated_at: now }).where(eq(s.ledgers.id, l.id));
      }
      // 身份:状态置 deleted + 凭据/联系信息清空(邮箱/手机唯一键释放)
      await tx
        .update(s.users)
        .set({ status: 'deleted', password_hash: null, email: null, phone: null, updated_at: now })
        .where(eq(s.users.id, userId));
      // 会话:全部吊销
      await tx
        .update(s.refresh_tokens)
        .set({ revoked_at: now })
        .where(and(eq(s.refresh_tokens.user_id, userId), isNull(s.refresh_tokens.revoked_at)));
    });
    logAudit({ actorUserId: userId, action: 'auth.account.deleted', summary: { ownedLedgers: 'soft-deleted' } });
    return { deleted: true };
  }

  async me(userId: string) {
    const u = (await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
    // P0-6:已注销账号拒绝访问(access token 最长残留 2 小时,注销后必须立即失效)
    if (!u || u.status === 'deleted') throw new AppError('auth.user.404', 404, '用户不存在');
    return this.publicUser(u);
  }

  /** 账号设置(M16/主币种,第 16 轮):昵称与主币种;主币种仅影响新建交易的记账币种,存量数据不回算 */
  async updateMe(userId: string, patch: { nickname?: string; baseCurrency?: string }): Promise<ReturnType<AuthService['publicUser']>> {
    const sets: Partial<typeof s.users.$inferInsert> = { updated_at: Date.now() };
    if (patch.nickname !== undefined) sets.nickname = patch.nickname.trim().slice(0, 30);
    if (patch.baseCurrency !== undefined) {
      const cur = patch.baseCurrency.toUpperCase();
      if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(cur)) {
        throw new AppError('user.currency.400', 400, `不支持的主币种: ${patch.baseCurrency}`);
      }
      sets.base_currency = cur;
    }
    await db.update(s.users).set(sets).where(eq(s.users.id, userId));
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
