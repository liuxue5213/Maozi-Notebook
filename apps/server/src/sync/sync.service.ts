import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { hasEffectiveChanges, mergeServerRow, mergeThreeWay } from '@ledgerone/sync';
import {
  newId, sanitizeEntityPayload,
  type ChangeOp, type EntityKind, type PullResponse, type PullRow, type PushChangeResult,
} from '@ledgerone/domain';
import { db } from '../db/db';
import * as s from '../db/schema';
import { AppError } from '../common/errors';
import { logAudit } from '../common/audit';
import { bootstrapIfNeeded, lockGlobalWrite, reserveSeq } from '../db/bootstrap';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TABLES: Record<EntityKind, any> = {
  ledger: s.ledgers,
  ledger_member: s.ledger_members,
  account: s.accounts,
  category: s.categories,
  tag: s.tags,
  transaction: s.transactions,
  budget: s.budgets,
  savings_plan: s.savings_plans,
  budget_item: s.budget_items,
  recurring_rule: s.recurring_rules,
  attachment: s.attachments,
  pending_transaction: s.pending_transactions,
  debt: s.debts,
  reimbursement: s.reimbursements,
};

/** 可直接按 ledger_id 过滤的下行实体;attachment / budget_item 在 pull 内用 join 处理 */
const PULL_CONFIG: Array<{ kind: EntityKind; table: any }> = [
  { kind: 'ledger', table: s.ledgers },
  { kind: 'ledger_member', table: s.ledger_members },
  { kind: 'account', table: s.accounts },
  { kind: 'category', table: s.categories },
  { kind: 'tag', table: s.tags },
  { kind: 'transaction', table: s.transactions },
  { kind: 'budget', table: s.budgets },
  { kind: 'savings_plan', table: s.savings_plans },
  { kind: 'recurring_rule', table: s.recurring_rules },
  { kind: 'pending_transaction', table: s.pending_transactions },
  { kind: 'debt', table: s.debts },
  { kind: 'reimbursement', table: s.reimbursements },
];

@Injectable()
export class SyncService {
  /**
   * 上行:批量幂等 upsert / 软删除,单次 ≤ 500(PRD 7.2)。
   * 每个 op 独立事务(上线前全检 B5):单个坏 op 返回 status='rejected' 而非整批回滚,
   * 避免毒丸批次永远堵住 outbox 队头;权限类 403 仍然抛出(整批拒绝,与既往语义一致)。
   */
  async push(userId: string, ops: ChangeOp[]): Promise<{ results: PushChangeResult[] }> {
    const results: PushChangeResult[] = [];
    // 同批 403 按原因去重留痕:防止单批 500 op 刷量膨胀 audit_logs(第 6 轮审查)
    const auditedForbidden = new Set<string>();
    // P1-17(第 25 轮):整批单事务 —— 修复前每 op 独立 BEGIN/COMMIT(500 op = 500 次事务)
    // 且各 op 重复更新同一 users 行;现整批一次写锁 + 一次序号预留,op 级失败用 SAVEPOINT 回退,
    // 「坏 op 不堵队头」语义不变,事务开销从 O(ops) 降为 O(1)。
    await db.transaction(async (tx) => {
      await lockGlobalWrite(tx);
      let seqCursor = await reserveSeq(tx, ops.length * 16);
      const nextSeq = () => seqCursor++;
      for (const op of ops) {
        try {
          // SAVEPOINT:单 op 失败只回退自身,已成功 op 的写入保留到外层提交
          await tx.transaction(async (sp: any) => {
            results.push(await this.applyOne(sp, userId, op, nextSeq));
          });
        } catch (e) {
          if (e instanceof AppError && e.status === 403) {
            const dedupeKey = `${e.code}:${e.message}`;
            if (!auditedForbidden.has(dedupeKey)) {
              auditedForbidden.add(dedupeKey);
              logAudit({
                actorUserId: userId,
                action: 'sync.forbidden.403',
                target: `${op.entity}:${op.entityId.slice(0, 8)}…`,
                summary: { message: e.message },
              });
            }
          }
          results.push({
            entityId: op.entityId,
            status: 'rejected',
            reason: e instanceof AppError ? `${e.code} ${e.message}`.slice(0, 200) : 'internal error',
          });
        }
      }
    });
    return { results };
  }

  private async applyOne(tx: any, userId: string, op: ChangeOp, nextSeq: () => number): Promise<PushChangeResult> {
    const table = TABLES[op.entity];
    if (!table) throw new AppError('sync.entity.400', 400, `未知实体类型: ${op.entity}`);
    const now = Date.now();
    // FOR UPDATE(第 19+20 轮 P0-5):并发双改同一行时串行化读取 —— 后到事务阻塞至先到提交后
    // 重读最新值再合并,消除「基于陈旧快照合并→UPDATE 整行覆盖掉对方已提交字段」的丢更新
    const readExisting = async (): Promise<any> =>
      (await tx.select().from(table).where(eq(table.id, op.entityId)).limit(1).for('update'))[0];
    let existing: any = await readExisting();
    // 删除不存在的行:幂等 noop(#28,先于权限/载荷处理,防止毒丸)
    if (op.op === 'delete' && !existing) {
      return { entityId: op.entityId, status: 'noop' };
    }

    let payload: Record<string, unknown> | null = null;
    if (op.op === 'upsert') {
      try {
        payload = sanitizeEntityPayload(op.entity, op.payload);
      } catch (e) {
        throw new AppError('sync.payload.rejected', 400, `载荷不合法(${op.entity} ${op.entityId.slice(0, 8)}…)`);
      }
      if (op.entity === 'transaction') {
        if (!payload.amount_base) payload.amount_base = payload.amount;
        payload.user_id = userId; // 创建者以服务端身份为准(PRD 5.2 user_id)
      }
    }

    // ---- 权限(PRD 6.3 服务端强制校验;B3:归属以服务端已有行为准) ----
    const ledgerId = await this.resolveLedgerId(tx, op.entity, payload, existing);
    if (op.entity === 'ledger') {
      if (payload) payload.owner_user_id = userId;
      if (existing && existing.owner_user_id !== userId) {
        throw new AppError('sync.forbidden.403', 403, '仅账本所有者可修改账本');
      }
    } else if (op.entity === 'ledger_member') {
      const m = ledgerId ? await this.membership(tx, userId, ledgerId) : undefined;
      if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
        throw new AppError('sync.forbidden.403', 403, '仅管理员可管理成员');
      }
      if (payload) payload.user_id = String(payload.user_id);
    } else if (ledgerId) {
      const m = await this.membership(tx, userId, ledgerId);
      if (!m) throw new AppError('sync.forbidden.403', 403, '无该账本权限');
      if (m.role === 'viewer') throw new AppError('sync.forbidden.403', 403, '只读成员不可写入');
    } else if (!existing) {
      throw new AppError('sync.ledger.400', 400, `${op.entity} 缺少可解析的 ledger_id`);
    }

    // ---- 新建 ----
    if (!existing) {
      if (op.op === 'delete' || !payload) return { entityId: op.entityId, status: 'noop' }; // 删除/空载荷不存在行:幂等 noop(#28)
      try {
        await tx.insert(table).values({ ...payload, id: op.entityId, client_version: op.clientVersion, server_version: nextSeq(), is_deleted: false, created_at: now, updated_at: now });
      } catch (e) {
        // 并发同 id 插入:MySQL 唯一冲突时重读对方已提交的行转入合并路径,
        // 而非裸抛 500(retryable)让客户端无限重试;其余错误原样上抛
        if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e;
        existing = await readExisting();
        if (!existing) throw e;
        return await this.applyUpdate(tx, userId, op, existing, payload, table, nextSeq, now);
      }
      if (op.entity === 'ledger') {
        // 新账本上行:自动补 owner 成员关系,使拉取范围立即覆盖
        await tx.insert(s.ledger_members).values({
          id: newId(), ledger_id: op.entityId, user_id: userId, role: 'owner', joined_at: now,
          client_version: 1, server_version: nextSeq(), is_deleted: false, created_at: now, updated_at: now,
        });
      }
      await this.recordChange(tx, userId, op, nextSeq, false, payload);
      return { entityId: op.entityId, status: 'applied' };
    }

    // ---- 删除(软删) ----
    if (op.op === 'delete') {
      if (existing.is_deleted) return { entityId: op.entityId, status: 'noop' };
      await tx.update(table).set({ is_deleted: true, deleted_at: now, client_version: Math.max(op.clientVersion, existing.client_version), server_version: nextSeq(), updated_at: now }).where(eq(table.id, op.entityId));
      await this.recordChange(tx, userId, op, nextSeq, false, null);
      return { entityId: op.entityId, status: 'applied' };
    }

    // ---- 更新 ----
    if (!payload) return { entityId: op.entityId, status: 'noop' };
    return this.applyUpdate(tx, userId, op, existing, payload, table, nextSeq, now);
  }

  /** 更新/合并路径(正常更新与并发同 id 插入的唯一冲突回退共用);前置:existing 已 FOR UPDATE 锁定 */
  private async applyUpdate(
    tx: any,
    userId: string,
    op: ChangeOp,
    existing: any,
    payload: Record<string, unknown>,
    table: any,
    nextSeq: () => number,
    now: number,
  ): Promise<PushChangeResult> {
    // 幂等重放(网络重试/重复出队):载荷与现有行完全等效 → noop(PRD 5.4)。
    // 并发安全由「行锁串行化 + 载荷等效 + 字段级合并」共同保证(B4 有集成测试守护)。
    if (!hasEffectiveChanges(existing, payload)) {
      return { entityId: op.entityId, status: 'noop' };
    }
    // 三方合并(第 13 轮):op.base 为编辑基线快照时逐字段三方对比,修复「陈旧非关键字段
    // 静默覆盖较新修改」;旧客户端不带 base → 退化整载荷 LWW(mergeServerRow,向后兼容)。
    const { merged, conflicts } = op.base
      ? mergeThreeWay(existing, payload, op.base)
      : mergeServerRow(existing, payload);
    merged.client_version = Math.max(Number(existing.client_version) || 0, op.clientVersion);
    merged.server_version = nextSeq();
    merged.updated_at = now;
    merged.is_deleted = false; // 覆盖或复活(回收站恢复)
    merged.deleted_at = null;
    delete merged.active_key; // MySQL 生成列不可显式更新
    await tx.update(table).set(merged).where(eq(table.id, op.entityId));
    await this.recordChange(tx, userId, op, nextSeq, conflicts.length > 0, payload);
    return conflicts.length
      ? { entityId: op.entityId, status: 'conflict', serverVersion: Number(merged.server_version), conflicts }
      : { entityId: op.entityId, status: 'applied', serverVersion: Number(merged.server_version) };
  }

  /**
   * 下行:server_version > cursor 的增量,按账本成员范围过滤(上线全检 #11/D14)。
   * - 整体置于可重复读事务:13 张表的读取基于同一快照,避免跨表撕裂;
   * - 空页时保持游标不变(不跳到 head):并发提交晚于本页读取的行,客户端下次 pull
   *   会在同一区间重新扫描,绝不漏发。
   */
  async pull(userId: string, cursor: number, limit = 500): Promise<PullResponse> {
    await bootstrapIfNeeded(userId);
    return db.transaction(
      async (tx: any) => {
        const myLedgerIds = (
          await tx
            .select({ ledger_id: s.ledger_members.ledger_id, is_deleted: s.ledger_members.is_deleted })
            .from(s.ledger_members)
            .where(and(eq(s.ledger_members.user_id, userId), eq(s.ledger_members.is_deleted, false)))
        )
          .filter((r: any) => !r.is_deleted)
          .map((r: any) => r.ledger_id);

        if (!myLedgerIds.length) {
          return { cursor, hasMore: false, rows: [] };
        }

        // P1-18(第 25 轮):键集两阶段 —— 修复前 13 个数据源各取 limit+1 行(约 6500 行)JS 排序
        // 截断到 500,过度读取 ~13 倍;现在第一段仅取 (entity, id, server_version) 键集
        // (UNION ALL 单查询精确 LIMIT limit+1),第二段按实体批量取完整行,过度读取归零。
        const ledgers = sql.join(myLedgerIds.map((id: string) => sql`${id}`), sql`, `);
        const parts: SQL[] = PULL_CONFIG.map((cfg) => {
          const scope =
            cfg.kind === 'ledger'
              ? sql`l.id in (${ledgers})`
              : cfg.kind === 'ledger_member'
                ? sql`l.user_id = ${userId}`
                : sql`l.ledger_id in (${ledgers})`;
          return sql`select ${cfg.kind} as entity, l.id as id, l.server_version as sv from ${cfg.table} l where l.server_version > ${cursor} and ${scope}`;
        });
        // attachments/budget_items 经父表归属账本(与 PULL_CONFIG 之后的联表口径一致)
        parts.push(sql`select 'attachment' as entity, a.id as id, a.server_version as sv from ${s.attachments} a join ${s.transactions} t on t.id = a.transaction_id where a.server_version > ${cursor} and t.ledger_id in (${ledgers})`);
        parts.push(sql`select 'budget_item' as entity, bi.id as id, bi.server_version as sv from ${s.budget_items} bi join ${s.budgets} b on b.id = bi.budget_id where bi.server_version > ${cursor} and b.ledger_id in (${ledgers})`);
        const [keys] = await tx.execute(sql`${sql.join(parts, sql` union all `)} order by sv limit ${limit + 1}`) as [Array<{ entity: string; id: string; sv: string | number }>, unknown];

        // 第二段:按实体批量取完整行(仅取键集命中的行,读取量 = 实际页面大小)
        const byEntity = new Map<EntityKind, string[]>();
        for (const k of keys) {
          const list = byEntity.get(k.entity as EntityKind) ?? [];
          list.push(k.id);
          byEntity.set(k.entity as EntityKind, list);
        }
        const rowById = new Map<string, PullRow>();
        for (const [entity, ids] of byEntity) {
          if (entity === 'attachment' || entity === 'budget_item') continue; // 下方按父表归属取行
          const t = PULL_CONFIG.find((c) => c.kind === entity)!.table;
          const rows = await tx.select().from(t).where(inArray(t.id, ids));
          for (const row of rows) {
            const { active_key: _internal, ...publicRow } = row;
            rowById.set(`${entity}:${row.id}`, { entity, row: publicRow });
          }
        }
        // attachments/budget_items 联表取行(键集已含归属过滤,按 id 直取)
        const attIds = byEntity.get('attachment') ?? [];
        if (attIds.length) {
          const rows = await tx.select().from(s.attachments).where(inArray(s.attachments.id, attIds));
          for (const row of rows) rowById.set(`attachment:${row.id}`, { entity: 'attachment', row });
        }
        const itemIds = byEntity.get('budget_item') ?? [];
        if (itemIds.length) {
          const rows = await tx.select().from(s.budget_items).where(inArray(s.budget_items.id, itemIds));
          for (const row of rows) {
            const { active_key: _internal, ...publicRow } = row;
            rowById.set(`budget_item:${row.id}`, { entity: 'budget_item', row: publicRow });
          }
        }

        // 键集已按 sv 全序排列(全局单序号无并列),按序组装页面
        const page: PullRow[] = [];
        for (const k of keys.slice(0, limit)) {
          const row = rowById.get(`${k.entity}:${k.id}`);
          if (row) page.push(row);
        }
        const hasMore = keys.length > limit;
        // 空页保持游标不动:head 与旧游标之间仍可能有并发提交的行,跳头会永久漏发
        const newCursor = page.length ? Number(page[page.length - 1].row.server_version ?? cursor) : cursor;
        return { cursor: newCursor, hasMore, rows: page };
      },
      { isolationLevel: 'repeatable read' } as any,
    );
  }

  private async membership(tx: any, userId: string, ledgerId: string): Promise<{ role: string } | undefined> {
    return (
      await tx
        .select({ role: s.ledger_members.role })
        .from(s.ledger_members)
        .where(and(eq(s.ledger_members.ledger_id, ledgerId), eq(s.ledger_members.user_id, userId), eq(s.ledger_members.is_deleted, false)))
        .limit(1)
    )[0];
  }

  /**
   * 归属解析(上线前全检 B3 / IDOR 修复):行已存在时以服务端存储的 ledger_id 为准;
   * 客户端提交的 ledger_id 与服务端不一致 → 403(防跨账本「搬家」混淆代理)。
   */
  private async resolveLedgerId(tx: any, entity: EntityKind, payload: Record<string, unknown> | null, existing: any): Promise<string | undefined> {
    const existingLedger = existing?.ledger_id != null ? String(existing.ledger_id) : undefined;
    const clientLedger = payload?.ledger_id != null ? String(payload.ledger_id) : undefined;
    if (existingLedger && clientLedger && existingLedger !== clientLedger) {
      throw new AppError('sync.forbidden.403', 403, '该行属于其他账本,拒绝修改');
    }
    const direct = existingLedger ?? clientLedger;
    if (direct) return direct;
    const src = payload ?? existing ?? {};
    if (entity === 'attachment' && src.transaction_id) {
      const r = (await tx.select({ l: s.transactions.ledger_id }).from(s.transactions).where(eq(s.transactions.id, String(src.transaction_id))).limit(1))[0];
      return r?.l;
    }
    if (entity === 'budget_item' && src.budget_id) {
      const r = (await tx.select({ l: s.budgets.ledger_id }).from(s.budgets).where(eq(s.budgets.id, String(src.budget_id))).limit(1))[0];
      return r?.l;
    }
    return undefined;
  }

  private async recordChange(tx: any, userId: string, op: ChangeOp, nextSeq: () => number, conflict: boolean, payload: Record<string, unknown> | null): Promise<void> {
    await tx.insert(s.sync_changes).values({
      id: newId(),
      user_id: userId,
      entity: op.entity,
      entity_id: op.entityId,
      op: op.op,
      client_version: op.clientVersion,
      server_version: nextSeq(),
      conflict,
      payload: payload ?? { id: op.entityId },
      created_at: Date.now(),
    });
  }
}
