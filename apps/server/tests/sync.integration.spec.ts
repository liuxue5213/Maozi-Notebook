/**
 * 服务端同步/鉴权集成测试(上线前全检 B8):
 * 使用 B7 产出的版本化迁移 SQL 在内存 PGlite 上建库,直测服务层,
 * 覆盖:引导播种、幂等重放、并发双改(B4)、毒丸批次(B5)、越权 403(B3)、删除幂等、pull 游标推进。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = 'pglite://memorydb';
process.env.NODE_ENV = 'test';
process.env.DEV_MODE = 'true'; // 测试需要回显 devCode(服务端生产环境由 fail-fast 禁止)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let authService: import('../src/auth/auth.service').AuthService;
let syncService: import('../src/sync/sync.service').SyncService;

beforeAll(async () => {
  // 1) 版本化迁移即测试基线(验证 B7 迁移 SQL 可从零建库)
  const drizzleDir = path.resolve(process.cwd(), 'drizzle');
  const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();

  // 2) env 先于模块加载设定,再动态引入
  const dbMod = await import('../src/db/db');
  db = dbMod.db;
  const { sql } = await import('drizzle-orm');
  for (const f of sqlFiles) {
    for (const stmt of readFileSync(path.join(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
      const s = stmt.trim();
      if (s) await db.execute(sql.raw(s));
    }
  }
  const { AuthService } = await import('../src/auth/auth.service');
  const { SyncService } = await import('../src/sync/sync.service');
  authService = new AuthService();
  syncService = new SyncService();
}, 60000);

async function register(email: string) {
  const r = await authService.register({ email, password: 'password123', nickname: 't' });
  return { userId: r.user.id, token: r.accessToken };
}

function op(entity: 'transaction', entityId: string, clientVersion: number, payload: Record<string, unknown>, baseVersion?: number | null) {
  return { entity, entityId, op: 'upsert' as const, payload, clientVersion, baseVersion, occurredAt: Date.now(), deviceId: 'test' };
}

async function seedTx(userId: string, ledgerId: string, catId: string, accId: string, txId: string, happenedAt = Date.now()) {
  const res = await syncService.push(userId, [
    op('transaction', txId, 1, {
      id: txId, ledger_id: ledgerId, type: 'expense', amount: '26', currency: 'CNY', amount_base: '26',
      category_id: catId, account_id: accId, happened_at: happenedAt, note: '', client_version: 1,
    }),
  ]);
  expect(res.results[0].status).toBe('applied');
  return res.results[0];
}

async function pullIds(userId: string) {
  const pull = await syncService.pull(userId, 0);
  const find = (entity: string) => pull.rows.find((r) => r.entity === entity)?.row as Record<string, unknown> | undefined;
  return {
    ledgerId: find('ledger')!.id as string,
    catId: find('category')!.id as string,
    accId: find('account')!.id as string,
    cursor: pull.cursor,
  };
}

describe('引导播种', () => {
  it('首次 pull 播种 1 账本 + 78 分类 + 2 账户 + owner 成员', async () => {
    const { userId } = await register(`t${Date.now()}@test.dev`);
    const pull = await syncService.pull(userId, 0);
    const tally: Record<string, number> = {};
    for (const r of pull.rows) tally[r.entity] = (tally[r.entity] ?? 0) + 1;
    expect(tally.ledger).toBe(1);
    expect(tally.category).toBe(78);
    expect(tally.account).toBe(2);
    expect(tally.ledger_member).toBe(1);
  });
});

describe('B4 并发双改不再丢数据', () => {
  it('同基线下 A 改金额、B 改备注:A conflict / B applied,金额保留、备注生效,两端意图均不丢', async () => {
    const { userId } = await register(`conc${Date.now()}@test.dev`);
    const { ledgerId, catId, accId } = await pullIds(userId);
    const txId = `tx-${Date.now()}`;
    const happenedAt = Date.now(); // A/B 与播种共用同一发生时间,避免关键字段幻影冲突
    const first = await seedTx(userId, ledgerId, catId, accId, txId, happenedAt);
    const s1 = first.serverVersion!; // A/B 共同基线

    const base = {
      id: txId, ledger_id: ledgerId, type: 'expense', currency: 'CNY',
      category_id: catId, account_id: accId, happened_at: happenedAt, client_version: 3,
    };
    // 设备 A:改金额(base=s1)
    const resA = await syncService.push(userId, [
      op('transaction', txId, 3, { ...base, amount: '30', amount_base: '30', note: '' }, s1),
    ]);
    expect(resA.results[0].status).toBe('conflict'); // 金额为关键字段 → 冲突,服务端保留 26
    expect(resA.results[0].conflicts).toEqual([{ field: 'amount' }]);

    // 设备 B:改备注(base 仍 = s1,因为 B 离线期间不知道 A 已写入)
    const resB = await syncService.push(userId, [
      op('transaction', txId, 3, { ...base, amount: '26', amount_base: '26', note: 'B 的备注' }, s1),
    ]);
    expect(resB.results[0].status).toBe('applied'); // 旧语义下这里是 noop(数据丢失),现在必须生效

    // 最终行:金额保留服务端值、备注为 B 的修改 —— 两端意图均未丢失
    const pull2 = await syncService.pull(userId, 0);
    const row = pull2.rows.find((r) => r.entity === 'transaction' && (r.row as any).id === txId)!.row as Record<string, unknown>;
    expect(row.note).toBe('B 的备注');
    expect(Number(row.amount)).toBe(26);
  });

  it('幂等重放:同载荷重复上行 → noop', async () => {
    const { userId } = await register(`replay${Date.now()}@test.dev`);
    const { ledgerId, catId, accId } = await pullIds(userId);
    const txId = `replay-${Date.now()}`;
    const payload = {
      id: txId, ledger_id: ledgerId, type: 'expense', amount: '9.9', amount_base: '9.9',
      category_id: catId, account_id: accId, happened_at: Date.now(), note: 'x', client_version: 1,
    };
    expect((await syncService.push(userId, [op('transaction', txId, 1, payload)])).results[0].status).toBe('applied');
    expect((await syncService.push(userId, [op('transaction', txId, 2, { ...payload, client_version: 2 })])).results[0].status).toBe('noop');
  });
});

describe('B5 毒丸批次不再阻塞', () => {
  it('坏 op 返回 rejected,同批好 op 正常 applied', async () => {
    const { userId } = await register(`pill${Date.now()}@test.dev`);
    const { ledgerId, catId, accId } = await pullIds(userId);
    const res = await syncService.push(userId, [
      op('transaction', 'bad-1', 1, { id: 'bad-1', ledger_id: ledgerId }), // 缺必填字段 → rejected
      op('transaction', `good-${Date.now()}`, 1, {
        id: `good-${Date.now()}`, ledger_id: ledgerId, type: 'expense', amount: '5', amount_base: '5',
        category_id: catId, account_id: accId, happened_at: Date.now(), note: '', client_version: 1,
      }),
    ]);
    expect(res.results[0].status).toBe('rejected');
    expect(res.results[0].reason).toBeTruthy();
    expect(res.results[1].status).toBe('applied');
  });

  it('删除不存在的行 → 幂等 noop(#28)', async () => {
    const { userId } = await register(`del${Date.now()}@test.dev`);
    const { ledgerId } = await pullIds(userId);
    const res = await syncService.push(userId, [
      { entity: 'transaction', entityId: 'never-existed', op: 'delete', payload: { id: 'never-existed', ledger_id: ledgerId }, clientVersion: 1, occurredAt: Date.now(), deviceId: 't' },
    ]);
    expect(res.results[0].status).toBe('noop');
  });
});

describe('B3 越权防护', () => {
  it('把他行「搬家」到自己的账本 → 403,且不回显服务端原值', async () => {
    const u1 = await register(`victim${Date.now()}@test.dev`);
    const u2 = await register(`attacker${Date.now()}@test.dev`);
    const ids1 = await pullIds(u1.userId);
    const ids2 = await pullIds(u2.userId);
    const txId = `victim-tx-${Date.now()}`;
    await seedTx(u1.userId, ids1.ledgerId, ids1.catId, ids1.accId, txId);

    // 攻击者:自己的 ledger_id + 受害者流水 UUID,尝试改金额
    const resA = await syncService.push(u2.userId, [
      op('transaction', txId, 2, {
        id: txId, ledger_id: ids2.ledgerId, type: 'expense', amount: '0.01', amount_base: '0.01',
        category_id: ids2.catId, account_id: ids2.accId, happened_at: Date.now(), note: '', client_version: 2,
      }),
    ]);
    // 搬家攻击:拒收且不回显服务端原值(reason 只有字段名与错误码)
    expect(resA.results[0].status).toBe('rejected');
    expect(resA.results[0].reason).toContain('403');
    expect(JSON.stringify(resA.results[0])).not.toContain('amount":');

    // 冲突响应不回显服务端原值(对合法用户)
    const res = await syncService.push(u1.userId, [
      op('transaction', txId, 3, {
        id: txId, ledger_id: ids1.ledgerId, type: 'expense', amount: '99', amount_base: '99',
        category_id: ids1.catId, account_id: ids1.accId, happened_at: Date.now(), note: '', client_version: 3,
      }, ids1.cursor),
    ]);
    expect(res.results[0].status).toBe('conflict');
    expect(JSON.stringify(res.results[0].conflicts)).not.toContain('serverValue');
  });

  it('被移除成员(软删)失去读写权', async () => {
    const owner = await register(`owner${Date.now()}@test.dev`);
    const ids = await pullIds(owner.userId);
    // 直接软删 owner 自己的成员关系模拟「被移除」
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('drizzle-orm')).sql`update ledger_members set is_deleted = true`,
    );
    await expect(syncService.pull(owner.userId, 0)).resolves.toBeTruthy(); // pull 不抛
    const res = await syncService.push(owner.userId, [
      op('transaction', `orphan-${Date.now()}`, 1, {
        id: `orphan-${Date.now()}`, ledger_id: ids.ledgerId, type: 'expense', amount: '1', amount_base: '1',
        category_id: ids.catId, account_id: ids.accId, happened_at: Date.now(), note: '', client_version: 1,
      }),
    ]);
    expect(res.results[0].status).toBe('rejected');
    expect(res.results[0].reason).toContain('403');
  });
});

describe('pull 游标推进', () => {
  it('首拉后用返回游标再拉 → 空增量', async () => {
    const { userId } = await register(`cursor${Date.now()}@test.dev`);
    const p1 = await syncService.pull(userId, 0);
    expect(p1.rows.length).toBeGreaterThan(0);
    const p2 = await syncService.pull(userId, p1.cursor);
    expect(p2.rows).toHaveLength(0);
    expect(p2.hasMore).toBe(false);
  });
});

describe('F-06/F-07 验证码安全', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let eq: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schema: any;

  beforeAll(async () => {
    eq = (await import('drizzle-orm')).eq;
    schema = await import('../src/db/schema');
  });

  const uniquePhone = () => `139${String(Date.now()).slice(-10)}`;

  it('验证码只存 HMAC 摘要(64 位 hex),不存明文;记录带冷却时间戳', async () => {
    const phone = uniquePhone();
    await authService.sendCode(phone);
    const rec = (await db.select().from(schema.phone_codes).where(eq(schema.phone_codes.phone, phone)).limit(1))[0];
    expect(rec.code_hash).toHaveLength(64);
    expect(rec.last_sent_at).toBeGreaterThan(0);
    expect(rec.attempts).toBe(0);
  });

  it('60s 冷却内重发 → 429', async () => {
    const phone = uniquePhone();
    await authService.sendCode(phone);
    await expect(authService.sendCode(phone)).rejects.toMatchObject({ status: 429 });
  });

  it('验证码错 5 次 → 锁定 423;锁定期内正确码与重发均被拒(F-06 不可绕过)', async () => {
    const phone = uniquePhone();
    const { devCode } = await authService.sendCode(phone);
    expect(devCode).toBeTruthy();
    // 前 4 次普通 401,第 5 次触发锁定(423)
    for (let i = 0; i < 4; i++) {
      await expect(authService.login({ phone, code: '000000' })).rejects.toMatchObject({ status: 401 });
    }
    await expect(authService.login({ phone, code: '000000' })).rejects.toMatchObject({ status: 423 });
    // 锁定后拿正确码也拒绝校验
    await expect(authService.login({ phone, code: devCode! })).rejects.toMatchObject({ status: 423 });
    // 锁定后把冷却拨回 60s 前再重发,仍必须被拒(否则「5 次锁定」会被 60s 重发架空)
    await db.execute(sql.raw(`update phone_codes set last_sent_at = ${Date.now() - 61_000} where phone = '${phone}'`));
    await expect(authService.sendCode(phone)).rejects.toMatchObject({ status: 423 });
  });

  it('正确验证码可登录并一次性消费(重放失败)', async () => {
    const phone = uniquePhone();
    const { devCode } = await authService.sendCode(phone);
    const pair = await authService.login({ phone, code: devCode! });
    expect(pair.accessToken).toBeTruthy();
    await expect(authService.login({ phone, code: devCode! })).rejects.toMatchObject({ code: 'auth.code.401' });
  });
});

describe('F-08 登出与会话管理', () => {
  it('revokeAllSessions 后旧 refresh token 不可再用(全端下线)', async () => {
    const r = await authService.register({ email: `logout${Date.now()}@test.dev`, password: 'password123' });
    await authService.revokeAllSessions(r.user.id);
    await expect(authService.refresh(r.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('refresh 轮换:旧 refresh token 用后即废', async () => {
    const r = await authService.register({ email: `rot${Date.now()}@test.dev`, password: 'password123' });
    const next = await authService.refresh(r.refreshToken);
    expect(next.refreshToken).toBeTruthy();
    await expect(authService.refresh(r.refreshToken)).rejects.toMatchObject({ status: 401 });
  });
});

describe('安全审计留痕(audit_logs)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schema: any;
  beforeAll(async () => {
    schema = await import('../src/db/schema');
  });

  const uniquePhone = () => `137${String(Date.now()).slice(-10)}`;

  /** 审计为 fire-and-forget 写入:轮询至出现匹配行(避免测试假阴性) */
  async function waitForAudit(action: string, filter?: (row: any) => boolean, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db.select().from(schema.audit_logs).where(eq(schema.audit_logs.action, action));
      const hit = filter ? rows.find(filter) : rows[rows.length - 1];
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`audit action not found: ${action}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('邮箱登录失败留痕:action=auth.login.failed,标识脱敏、不含密码', async () => {
    const email = `auditfail${Date.now()}@test.dev`;
    await expect(authService.login({ email, password: 'wrong-password' })).rejects.toMatchObject({ status: 401 });
    const row = await waitForAudit('auth.login.failed', (r) => r.target_entity === 'au***@test.dev');
    expect(row.summary).toMatchObject({ reason: 'bad_credentials' });
    expect(JSON.stringify(row)).not.toContain('wrong-password');
    expect(row.actor_user_id).toBeNull();
  });

  it('验证码错 5 次留痕 verify_failed × 5 + locked(lock_created);锁定期内校验/重发均留痕', async () => {
    const phone = uniquePhone();
    await authService.sendCode(phone);
    for (let i = 0; i < 4; i++) {
      await expect(authService.login({ phone, code: '000000' })).rejects.toMatchObject({ status: 401 });
    }
    await expect(authService.login({ phone, code: '000000' })).rejects.toMatchObject({ status: 423 });
    const failed = await db.select().from(schema.audit_logs).where(eq(schema.audit_logs.action, 'auth.code.verify_failed'));
    const mine = failed.filter((r: any) => r.target_entity === `****${phone.slice(-4)}`);
    expect(mine.length).toBe(5);
    expect(mine[4].summary).toMatchObject({ attempts: 5 });
    await waitForAudit('auth.code.locked', (r) => r.target_entity === `****${phone.slice(-4)}` && r.summary?.phase === 'lock_created');
    // 锁定期内:校验被拒与重发被拒各留一条(是攻击探测信号)
    await expect(authService.login({ phone, code: '000000' })).rejects.toMatchObject({ status: 423 });
    await db.execute(sql.raw(`update phone_codes set last_sent_at = ${Date.now() - 61_000} where phone = '${phone}'`));
    await expect(authService.sendCode(phone)).rejects.toMatchObject({ status: 423 });
    await waitForAudit('auth.code.send_locked', (r) => r.target_entity === `****${phone.slice(-4)}`);
  });

  it('refresh 轮换与失败留痕;登出留痕(全端下线)', async () => {
    const r = await authService.register({ email: `audrot${Date.now()}@test.dev`, password: 'password123' });
    await authService.refresh(r.refreshToken);
    const rotated = await waitForAudit('auth.refresh.rotated', (x) => x.actor_user_id === r.user.id);
    expect(rotated.summary).toBeNull();
    await expect(authService.refresh('bogus-refresh-token-value')).rejects.toMatchObject({ status: 401 });
    await waitForAudit('auth.refresh.failed', (x) => x.target_entity === 'invalid_or_expired_token');
    await authService.revokeAllSessions(r.user.id);
    await waitForAudit('auth.logout', (x) => x.actor_user_id === r.user.id);
  });

  it('sync 越权 403 留痕:攻击者 id + 目标行(截断),不泄露服务端数据', async () => {
    const u1 = await register(`audvictim${Date.now()}@test.dev`);
    const u2 = await register(`audattacker${Date.now()}@test.dev`);
    const ids1 = await pullIds(u1.userId);
    const ids2 = await pullIds(u2.userId);
    const txId = `aud-tx-${Date.now()}`;
    await seedTx(u1.userId, ids1.ledgerId, ids1.catId, ids1.accId, txId);
    await syncService.push(u2.userId, [
      op('transaction', txId, 2, {
        id: txId, ledger_id: ids2.ledgerId, type: 'expense', amount: '0.01', amount_base: '0.01',
        category_id: ids2.catId, account_id: ids2.accId, happened_at: Date.now(), note: '', client_version: 2,
      }),
    ]);
    const row = await waitForAudit('sync.forbidden.403', (x) => x.actor_user_id === u2.userId);
    expect(row.target_entity).toMatch(/^transaction:/);
    expect(JSON.stringify(row.summary)).not.toContain('amount');
    expect(row.ledger_id).toBeNull();
  });

  it('审计日志保留策略:90 天外的行被清理,近期保留(第 6 轮 P3)', async () => {
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
    await db.execute(sql.raw(`insert into audit_logs (id, action, created_at) values ('audit-old', 'auth.login.failed', ${old})`));
    await db.execute(sql.raw(`insert into audit_logs (id, action, created_at) values ('audit-new', 'auth.login.failed', ${Date.now()})`));
    const { purgeAuditLogs } = await import('../src/purge');
    const purged = await purgeAuditLogs();
    expect(purged).toBeGreaterThanOrEqual(1);
    const remaining = await db.select().from(schema.audit_logs);
    const ids = remaining.map((r: any) => r.id);
    expect(ids).not.toContain('audit-old');
    expect(ids).toContain('audit-new');
  });
});
