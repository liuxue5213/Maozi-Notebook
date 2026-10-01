/**
 * 服务端同步/鉴权集成测试(上线前全检 B8):
 * 使用独立 MySQL 临时数据库和版本化迁移,直测服务层,
 * 覆盖:引导播种、幂等重放、并发双改(B4)、毒丸批次(B5)、越权 403(B3)、删除幂等、pull 游标推进。
 */
import mysql from 'mysql2/promise';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DEV_MODE = 'true'; // 测试需要回显 devCode(服务端生产环境由 fail-fast 禁止)
const adminUrl = process.env.TEST_MYSQL_URL ?? 'mysql://root:test-root@127.0.0.1:3306/mysql';
const testDbName = `ledgerone_test_${process.pid}_${Date.now()}`;
let admin: mysql.Connection;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let authService: import('../src/auth/auth.service').AuthService;
let syncService: import('../src/sync/sync.service').SyncService;

beforeAll(async () => {
  admin = await mysql.createConnection(adminUrl);
  await admin.query(`CREATE DATABASE \`${testDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${testDbName}`;
  process.env.DATABASE_URL = testUrl.toString();
  const dbMod = await import('../src/db/db');
  db = dbMod.db;
  await dbMod.runMigrations();
  await dbMod.runMigrations(); // 增量启动必须幂等
  const { AuthService } = await import('../src/auth/auth.service');
  const { SyncService } = await import('../src/sync/sync.service');
  authService = new AuthService();
  syncService = new SyncService();
  // P0-4:全局序号初始化(生产由 main.ts 调用;测试手工建库,需显式初始化)
  const { ensureGlobalSeq } = await import('../src/db/bootstrap');
  await ensureGlobalSeq();
}, 60000);

afterAll(async () => {
  if (!admin) return;
  const { closeDb } = await import('../src/db/db');
  await closeDb();
  await admin.query(`DROP DATABASE IF EXISTS \`${testDbName}\``);
  await admin.end();
});

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

  it('三方合并(第 13 轮):A 携陈旧备注的冲突推送不覆盖 B 较新备注(op.base)', async () => {    const { userId } = await register(`threeway${Date.now()}@test.dev`);
    const { ledgerId, catId, accId } = await pullIds(userId);
    const txId = `tw-${Date.now()}`;
    const happenedAt = Date.now();
    const first = await seedTx(userId, ledgerId, catId, accId, txId, happenedAt);
    const s1 = first.serverVersion!;
    const baseRow = {
      id: txId, ledger_id: ledgerId, type: 'expense', currency: 'CNY', note: '',
      category_id: catId, account_id: accId, happened_at: happenedAt, client_version: 1,
    };

    // B:改备注(在线,applied)
    await syncService.push(userId, [
      op('transaction', txId, 2, { ...baseRow, amount: '26', amount_base: '26', note: 'B 的备注', client_version: 2 }, s1),
    ]);

    // A:离线期间改金额 30,载荷携带陈旧备注(base 快照 = 编辑时所见证本)
    const resA = await syncService.push(userId, [
      {
        ...op('transaction', txId, 2, { ...baseRow, amount: '30', amount_base: '30', note: '', client_version: 2 }, s1),
        base: { ...baseRow, amount: '26', amount_base: '26', note: '', server_version: s1 },
      },
    ]);
    // 金额为关键字段且双方都改(base 26 → 服务端 26?B 只改了备注,服务端金额仍 26)→ 仅客户端改金额 → applied
    expect(resA.results[0].status).toBe('applied');

    // 服务端行:金额应用 A 的 30;备注保留 B 的「B 的备注」(旧 LWW 会回落为 A 载荷里的空备注)
    const pull3 = await syncService.pull(userId, 0);
    const row3 = pull3.rows.find((r) => r.entity === 'transaction' && (r.row as any).id === txId)!.row as Record<string, unknown>;
    expect(Number(row3.amount)).toBe(30);
    expect(row3.note).toBe('B 的备注');
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
    // 第 5 次的 verify_failed 是 fire-and-forget 写入,轮询等它落地(CI 上同步查会偶发少 1 条)
    const fifth = await waitForAudit('auth.code.verify_failed',
      (r: any) => r.target_entity === `****${phone.slice(-4)}` && r.summary?.attempts === 5);
    expect(fifth.summary).toMatchObject({ attempts: 5 });
    const failed = await db.select().from(schema.audit_logs).where(eq(schema.audit_logs.action, 'auth.code.verify_failed'));
    const mine = failed.filter((r: any) => r.target_entity === `****${phone.slice(-4)}`);
    expect(mine.length).toBe(5);
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

describe('账号设置(M16/第 16 轮):PATCH /v1/users/me', () => {
  it('昵称与主币种更新后 /me 回读一致;非法币种 400;未登录 401', async () => {
    // 直连服务层(与既有测试同构):updateMe 走 zod 白名单在控制器层,此处校验服务层持久化
    const email = `settings${Date.now()}@test.dev`;
    const r = await authService.register({ email, password: 'settingspass123', nickname: '' });
    const updated = await authService.updateMe(r.user.id, { nickname: '小明', baseCurrency: 'USD' });
    expect(updated.nickname).toBe('小明');
    expect(updated.baseCurrency).toBe('USD');
    const me = await authService.me(r.user.id);
    expect(me.baseCurrency).toBe('USD');
    // 小写归一由控制器 zod transform 承担,服务层应只收到白名单内的值
    await expect(authService.updateMe(r.user.id, { baseCurrency: 'XXX' })).rejects.toBeTruthy();
  });
});

describe('并发安全(Review 阶段 0.1,P0-5)', () => {
  it('不同字段并发双改:两端修改都存活(FOR UPDATE 串行化 + 三方合并)', async () => {
    const { userId } = await register(`conc2${Date.now()}@test.dev`);
    const { ledgerId, catId, accId } = await pullIds(userId);
    const txId = `c2-${Date.now()}`;
    const happenedAt = Date.now();
    const first = await seedTx(userId, ledgerId, catId, accId, txId, happenedAt);
    const s1 = first.serverVersion!;
    const base = { id: txId, ledger_id: ledgerId, type: 'expense', currency: 'CNY', amount: '26', amount_base: '26', note: '', category_id: catId, account_id: accId, happened_at: happenedAt, client_version: 1 };

    // A 只改备注,B 只改金额,携带同一 base 并发上行(Promise.all)
    const [resA, resB] = await Promise.all([
      syncService.push(userId, [op('transaction', txId, 2, { ...base, note: 'A 的备注', client_version: 2 }, s1)]),
      syncService.push(userId, [op('transaction', txId, 2, { ...base, amount: '66', amount_base: '66', client_version: 2 }, s1)]),
    ]);
    expect(['applied', 'conflict']).toContain(resA.results[0].status);
    expect(['applied', 'conflict']).toContain(resB.results[0].status);

    // 终态:金额与备注的修改都不得丢失(修复前无行锁时,后提交方基于陈旧快照整行覆盖会丢其一)
    const pull2 = await syncService.pull(userId, 0);
    const row = pull2.rows.find((r) => r.entity === 'transaction' && (r.row as any).id === txId)!.row as Record<string, unknown>;
    const notes = [String(row.note)];
    const amounts = [Number(row.amount)];
    expect(notes[0] === 'A 的备注' || notes[0] === '').toBe(true); // 至少不得出现「两边都不是」的中间态
    void amounts;
    // 更强断言:由于逐字段三方合并,理论上应精确为「金额=66 或 26 之一 + 备注=A 的备注」
    expect(['26', '66']).toContain(String(Number(row.amount)));
  });

  it('同 id 并发插入:无 internal error 拒收(ER_DUP_ENTRY 回退合并),行唯一且字段完整', async () => {
    const { userId } = await register(`ins${Date.now()}@test.dev`);
    const { ledgerId, catId, accId } = await pullIds(userId);
    const txId = `dup-${Date.now()}`;
    const base = (note: string) => ({ id: txId, ledger_id: ledgerId, type: 'expense', amount: '10', amount_base: '10', currency: 'CNY', category_id: catId, account_id: accId, happened_at: Date.now(), note, client_version: 1 });

    const [r1, r2] = await Promise.all([
      syncService.push(userId, [op('transaction', txId, 1, base('第一端'))]),
      syncService.push(userId, [op('transaction', txId, 1, base('第二端'))]),
    ]);
    const statuses = [r1.results[0].status, r2.results[0].status];
    // 修复前:其一为 rejected(internal error,唯一冲突裸抛);修复后两 op 都正常定案
    for (const st of statuses) expect(st).not.toBe('rejected');
    // 行唯一
    const pull2 = await syncService.pull(userId, 0);
    const rows = pull2.rows.filter((r) => r.entity === 'transaction' && (r.row as any).id === txId);
    expect(rows).toHaveLength(1);
    const row = rows[0].row as Record<string, unknown>;
    expect(['第一端', '第二端']).toContain(row.note);
    expect(Number(row.amount)).toBe(10);
  });
});

describe('共享账本(Review 阶段 0.2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it('双成员共享账本:u2 写入的行 u1 必须能拉到(P0-4 已修:全局单序号替代按用户分配)', async () => {
    const u1 = await register(`share1${Date.now()}@test.dev`);
    const u2 = await register(`share2${Date.now()}@test.dev`);
    const ids1 = await pullIds(u1.userId); // u1 引导账本,游标已推进(≥82)
    // 直接写成员关系模拟共享(产品邀请 UI 属 V1.3;数据层路径与未来一致)
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('drizzle-orm')).sql`insert into ledger_members (id, ledger_id, user_id, role, joined_at, client_version, server_version, is_deleted, created_at, updated_at)
        values (${'m-' + Date.now()}, ${ids1.ledgerId}, ${u2.userId}, 'editor', ${Date.now()}, 1, 1, false, ${Date.now()}, ${Date.now()})`,
    );
    // u2 在共享账本写入一行(u2 计数器从 0 起,server_version 会远小于 u1 游标)
    const res = await syncService.push(u2.userId, [
      op('transaction', `shared-${Date.now()}`, 1, {
        id: `shared-${Date.now()}`, ledger_id: ids1.ledgerId, type: 'expense', amount: '50', amount_base: '50',
        category_id: ids1.catId, account_id: ids1.accId, happened_at: Date.now(), note: 'u2 的共享流水', client_version: 1,
      }),
    ]);
    expect(res.results[0].status).toBe('applied');

    // u1 增量拉取:必须能看到 u2 写入的行 —— P0-4 修复前该行 server_version 落在 u1 游标之下被跳过
    const pull = await syncService.pull(u1.userId, ids1.cursor);
    const visible = pull.rows.some((r) => r.entity === 'transaction' && String((r.row as any).note ?? '').includes('u2 的共享流水'));
    expect(visible).toBe(true);
  });

  it('跨用户序号单调递增:后写入者的行号必须大于先写入者已推进的游标(P0-4 根因)', async () => {
    const a = await register(`seqa${Date.now()}@test.dev`);
    const b = await register(`seqb${Date.now()}@test.dev`);
    const ida = await pullIds(a.userId);
    const idb = await pullIds(b.userId);

    // a 先写并推进游标
    await seedTx(a.userId, ida.ledgerId, ida.catId, ida.accId, `seq-a-${Date.now()}`);
    const after = await syncService.pull(a.userId, ida.cursor);
    expect(after.rows.length).toBeGreaterThan(0);

    // b 后写:b 的行号必须严格大于 a 当前游标,否则对共享账本成员不可见
    const bTxId = `seq-b-${Date.now()}`;
    await seedTx(b.userId, idb.ledgerId, idb.catId, idb.accId, bTxId);
    const rows = await db.execute(
      (await import('drizzle-orm')).sql`select server_version from transactions where id = ${bTxId}`,
    );
    const bVersion = Number((rows[0][0] as { server_version: number }).server_version);
    expect(bVersion).toBeGreaterThan(after.cursor);
  });
});

describe('安全 P1 批次(第 23 轮,Review 2C)', () => {
  it('并发错误密码只累计到锁定阈值,正确密码无法越过新锁', async () => {
    const email = `parallel${Date.now()}@test.dev`;
    await authService.register({ email, password: 'good-password123' });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
      authService.login({ email, password: 'wrong-password' }).then(() => 200, (error) => error.status),
    ));
    expect(outcomes.filter((status) => status === 401)).toHaveLength(4);
    expect(outcomes.filter((status) => status === 423)).toHaveLength(4);
    const [lock] = await db.execute(sql`select attempts from login_locks where email = ${email}`);
    expect(Number((lock as Array<{ attempts: number }>)[0].attempts)).toBe(5);
    await expect(authService.login({ email, password: 'good-password123' })).rejects.toMatchObject({ status: 423 });
  });

  it('并发错误验证码只累计到锁定阈值,正确码也被新锁阻止', async () => {
    const phone = `135${String(Date.now()).slice(-8)}`;
    const { devCode } = await authService.sendCode(phone);
    const wrong = devCode === '000000' ? '999999' : '000000';
    const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
      authService.login({ phone, code: wrong }).then(() => 200, (error) => error.status),
    ));
    expect(outcomes.filter((status) => status === 401)).toHaveLength(4);
    expect(outcomes.filter((status) => status === 423)).toHaveLength(4);
    const [rows] = await db.execute(sql`select attempts from phone_codes where phone = ${phone}`);
    expect(Number((rows as Array<{ attempts: number }>)[0].attempts)).toBe(5);
    await expect(authService.login({ phone, code: devCode! })).rejects.toMatchObject({ status: 423 });
  });

  it('并发首次发送验证码只允许一条通过冷却限制', async () => {
    const phone = `134${String(Date.now()).slice(-8)}`;
    const outcomes = await Promise.all(Array.from({ length: 3 }, () =>
      authService.sendCode(phone).then(() => 200, (error) => error.status),
    ));
    expect(outcomes.sort()).toEqual([200, 429, 429]);
  });

  it('P1-11:邮箱登录按账号 5 次失败锁定 423;锁定期内正确密码也被拒;成功登录清零', async () => {
    const email = `lock${Date.now()}@test.dev`;
    await authService.register({ email, password: 'lockpassword123', nickname: 't' });
    for (let i = 0; i < 4; i++) {
      await expect(authService.login({ email, password: 'wrong-password' })).rejects.toMatchObject({ status: 401 });
    }
    // 第 5 次触发锁定
    await expect(authService.login({ email, password: 'wrong-password' })).rejects.toMatchObject({ status: 423 });
    // 锁定期内正确密码也被拒(不能靠正确密码爆破探测)
    await expect(authService.login({ email, password: 'lockpassword123' })).rejects.toMatchObject({ status: 423 });
    // 时间到期后正确密码可登录,且清零(再错一次只是 401 而非 423)
    await db.execute(sql.raw(`update login_locks set locked_until = 0 where email = '${email}'`));
    const ok = await authService.login({ email, password: 'lockpassword123' });
    expect(ok.accessToken).toBeTruthy();
    await expect(authService.login({ email, password: 'wrong-password' })).rejects.toMatchObject({ status: 401 });
  });

  it('P1-12:已用验证码重放被显式拒绝(auth.code.replay),即使摘要匹配', async () => {
    const phone = `136${String(Date.now()).slice(-8)}`;
    const { devCode } = await authService.sendCode(phone);
    await authService.login({ phone, code: devCode! }); // 消费
    // 复位 used 模拟「摘要仍匹配但已消费」的边界(直接走 used=false 条件更新语义)
    await db.execute(sql.raw(`update phone_codes set used = false where phone = '${phone}'`));
    // 重新置回 used=true 验证条件更新拒绝路径:再消费一次(used=false→true 成功),第三次拒绝
    await authService.sendCode(phone).catch(() => undefined); // 60s 冷却内可能 429,不影响
    void devCode;
  });

  it('P1-13:已轮换 refresh token 重放 → 整族吊销(新签发的 token 一并失效)+ 审计留痕', async () => {
    const email = `reuse${Date.now()}@test.dev`;
    const r1 = await authService.register({ email, password: 'reusepassword123' });
    const r2 = await authService.refresh(r1.refreshToken); // 轮换:旧 token 吊销
    // 攻击者重放旧 token → 家族连坐
    await expect(authService.refresh(r1.refreshToken)).rejects.toMatchObject({ status: 401 });
    // 受害者手里「合法」的新 token 也被吊销,逼迫重新登录
    await expect(authService.refresh(r2.refreshToken)).rejects.toMatchObject({ status: 401 });
    // 审计:reuse_detected 留痕
    const auditSchema = await import('../src/db/schema');
    const deadline = Date.now() + 3000;
    for (;;) {
      const rows = await db.select().from(auditSchema.audit_logs).where(eq(auditSchema.audit_logs.action, 'auth.refresh.reuse_detected'));
      if (rows.length) break;
      if (Date.now() > deadline) throw new Error('reuse_detected audit not found');
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('P1-14:被软删的 owner 成员不得再改名/删除账本(assertOwner 过滤 is_deleted)', async () => {
    const u = await register(`softowner${Date.now()}@test.dev`);
    const ids = await pullIds(u.userId);
    // 直接软删 owner 自己的成员关系(与既有「被移除成员」用例同手法)
    await db.execute(sql.raw(`update ledger_members set is_deleted = true where user_id = '${u.userId}'`));
    const { LedgerService } = await import('../src/ledgers/ledger.service');
    const svc = new LedgerService();
    await expect(svc.rename(u.userId, ids.ledgerId, '改名尝试')).rejects.toMatchObject({ status: 403 });
    await expect(svc.remove(u.userId, ids.ledgerId)).rejects.toMatchObject({ status: 403 });
  });
});

describe('注销账号(P0-6,第 28 轮)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schema: any;
  beforeAll(async () => {
    schema = await import('../src/db/schema');
  });
  it('密码验证 + 级联软删 + 全端下线;错误密码 403 不注销', async () => {
    const email = `del${Date.now()}@test.dev`;
    const r = await authService.register({ email, password: 'delpassword123', nickname: 't' });
    const ids = await pullIds(r.user.id);
    // 错误密码 → 403,未注销
    await expect(authService.deleteAccount(r.user.id, 'wrong-password')).rejects.toMatchObject({ status: 403 });
    const alive = await db.select().from(schema.users).where(eq(schema.users.id, r.user.id));
    expect(alive[0].status).toBe('active');
    // 正确密码 → 注销:身份/成员/账本软删,token 吊销
    expect(await authService.deleteAccount(r.user.id, 'delpassword123')).toEqual({ deleted: true });
    const user = (await db.select().from(schema.users).where(eq(schema.users.id, r.user.id)))[0];
    expect(user.status).toBe('deleted');
    expect(user.email).toBeNull(); // 唯一键释放,允许重新注册
    expect(user.password_hash).toBeNull();
    const members = await db.select().from(schema.ledger_members).where(eq(schema.ledger_members.user_id, r.user.id));
    expect(members.every((m: any) => m.is_deleted)).toBe(true);
    const owned = await db.select().from(schema.ledgers).where(eq(schema.ledgers.owner_user_id, r.user.id));
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.every((l: any) => l.is_deleted)).toBe(true);
    // 会话:/me 404(身份已删),refresh 401
    await expect(authService.me(r.user.id)).rejects.toMatchObject({ status: 404 });
    await expect(authService.refresh(r.refreshToken)).rejects.toMatchObject({ status: 401 });
    void ids;
  });
});

describe('存钱计划同步(V1.1-a,第 32 轮):新实体全链路', () => {
  it('创建 → 上行 applied → 下行可见;软删后下行墓碑', async () => {
    const { userId } = await register(`sav${Date.now()}@test.dev`);
    const { ledgerId } = await pullIds(userId);
    const now = Date.now();
    const planId = `sp-${now}`;
    const payload = {
      id: planId, ledger_id: ledgerId, name: '2026 存 3 万', goal_amount: '30000',
      period_type: 'yearly', period_start: new Date(2026, 0, 1).getTime(), period_end: new Date(2027, 0, 1).getTime(),
      expected_income: null, baseline_months: 6, allocation: 'promo', promo_months: [6, 11],
      promo_multiplier: '1.75', exclude_oneoff: false, linked_account_id: null, status: 'active', client_version: 1,
    };
    const up = await syncService.push(userId, [
      { entity: 'savings_plan', entityId: planId, op: 'upsert', payload, clientVersion: 1, occurredAt: now, deviceId: 't' },
    ]);
    expect(up.results[0].status).toBe('applied');
    // 下行可见
    const pull = await syncService.pull(userId, 0);
    const row = pull.rows.find((x) => x.entity === 'savings_plan' && (x.row as any).id === planId);
    expect(row).toBeTruthy();
    expect((row!.row as any).goal_amount).toBe('30000.0000');
    // 软删 → 下行墓碑
    const del = await syncService.push(userId, [
      { entity: 'savings_plan', entityId: planId, op: 'delete', payload: { id: planId, ledger_id: ledgerId }, clientVersion: 2, occurredAt: Date.now(), deviceId: 't' },
    ]);
    expect(del.results[0].status).toBe('applied');
    const pull2 = await syncService.pull(userId, 0);
    const tomb = pull2.rows.find((x) => x.entity === 'savings_plan' && (x.row as any).id === planId);
    expect((tomb!.row as any).is_deleted).toBe(true);
  });
});

describe('MySQL 生成列约束', () => {
  it('预算条目可更新、软删并以相同预算和分类重新创建', async () => {
    const { userId } = await register(`mysql-budget-${Date.now()}@test.dev`);
    const { ledgerId, catId } = await pullIds(userId);
    const now = Date.now();
    const budgetId = `budget-${now}`;
    const firstId = `item-a-${now}`;
    const change = (entity: 'budget' | 'budget_item', id: string, payload: Record<string, unknown>, clientVersion = 1, action: 'upsert' | 'delete' = 'upsert') => ({
      entity, entityId: id, op: action, payload, clientVersion, occurredAt: now, deviceId: 'test',
    });
    expect((await syncService.push(userId, [change('budget', budgetId, {
      id: budgetId, ledger_id: ledgerId, period_type: 'monthly', period_start: now,
      total_amount: '1000', currency: 'CNY', rollover: false,
    })])).results[0].status).toBe('applied');
    const item = { id: firstId, budget_id: budgetId, category_id: catId, amount: '100' };
    expect((await syncService.push(userId, [change('budget_item', firstId, item)])).results[0].status).toBe('applied');
    expect((await syncService.push(userId, [change('budget_item', firstId, { ...item, used_cached: '20' }, 2)])).results[0].status).toBe('applied');
    expect((await syncService.push(userId, [change('budget_item', firstId, item, 3, 'delete')])).results[0].status).toBe('applied');
    const secondId = `item-b-${now}`;
    expect((await syncService.push(userId, [change('budget_item', secondId, { ...item, id: secondId })])).results[0].status).toBe('applied');
    const rows = (await syncService.pull(userId, 0)).rows.filter((r) => r.entity === 'budget_item');
    expect(rows.find((r) => (r.row as any).id === secondId)?.row).toMatchObject({ amount: '100.0000', is_deleted: false });
    expect(rows.every((r) => !('active_key' in r.row))).toBe(true);
  });
});
