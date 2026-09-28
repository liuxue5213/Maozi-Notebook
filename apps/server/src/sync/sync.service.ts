import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { hasEffectiveChanges, mergeServerRow } from '@ledgerone/sync';
import {
  newId, sanitizeEntityPayload,
  type ChangeOp, type EntityKind, type PullResponse, type PullRow, type PushChangeResult,
} from '@ledgerone/domain';
import { db } from '../db/db';
import * as s from '../db/schema';
import { AppError } from '../common/errors';
import { logAudit } from '../common/audit';
import { bootstrapIfNeeded, reserveSeq } from '../db/bootstrap';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TABLES: Record<EntityKind, any> = {
  ledger: s.ledgers,
  ledger_member: s.ledger_members,
  account: s.accounts,
  category: s.categories,
  tag: s.tags,
  transaction: s.transactions,
  budget: s.budgets,
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
    for (const op of ops) {
      try {
        const res = await db.transaction(async (tx) => {
          // 每个 op 预留序号池:行本身 + 派生成员行 + sync_change,游标允许空洞
          let seqCursor = await reserveSeq(tx, userId, 16);
          const nextSeq = () => seqCursor++;
          return this.applyOne(tx, userId, op, nextSeq);
        });
        results.push(res);
      } catch (e) {
        // 任何错误(含 403 越权)都只拒收该 op 并附带原因,绝不阻塞队列;
        // 响应不含服务端数据,攻击者得不到任何回显(B3/B5)。
        if (e instanceof AppError && e.status === 403) {
          // 越权尝试留痕(上线全检审计待办):跨账本「搬家」/无权限写入是灰度期重点监控对象
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
    return { results };
  }

  private async applyOne(tx: any, userId: string, op: ChangeOp, nextSeq: () => number): Promise<PushChangeResult> {
    const table = TABLES[op.entity];
    if (!table) throw new AppError('sync.entity.400', 400, `未知实体类型: ${op.entity}`);
    const now = Date.now();
    const existing: any = (await tx.select().from(table).where(eq(table.id, op.entityId)).limit(1))[0];
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
      await tx.insert(table).values({ ...payload, id: op.entityId, client_version: op.clientVersion, server_version: nextSeq(), is_deleted: false, created_at: now, updated_at: now });
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
    // 幂等重放(网络重试/重复出队):载荷与现有行完全等效 → noop(PRD 5.4)。
    // 并发安全由「载荷等效 + 字段级合并」共同保证:任何与现有行不一致的载荷一律走合并,
    // 关键字段(MANUAL_FIELDS)冲突不裁决,绝不静默丢弃客户端修改(B4,有集成测试守护)。
    // 注:op.baseVersion 目前仅作协议预留/排查线索(客户端编辑基线),服务端裁决不依赖它。
    if (!hasEffectiveChanges(existing, payload)) {
      return { entityId: op.entityId, status: 'noop' };
    }
    const { merged, conflicts } = mergeServerRow(existing, payload);
    merged.client_version = Math.max(Number(existing.client_version) || 0, op.clientVersion);
    merged.server_version = nextSeq();
    merged.updated_at = now;
    merged.is_deleted = false; // 覆盖或复活(回收站恢复)
    merged.deleted_at = null;
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

        const rows: PullRow[] = [];
        const push = (kind: EntityKind, arr: any[]) => rows.push(...arr.map((row) => ({ entity: kind, row })));

        if (myLedgerIds.length) {
          for (const cfg of PULL_CONFIG) {
            const t = cfg.table;
            const conds = [gt(t.server_version, cursor)];
            if (cfg.kind === 'ledger') conds.push(inArray(t.id, myLedgerIds));
            else if (cfg.kind === 'ledger_member') conds.push(eq(t.user_id, userId));
            else conds.push(inArray(t.ledger_id, myLedgerIds));
            const part = await tx.select().from(t).where(and(...conds)).orderBy(t.server_version).limit(limit + 1);
            push(cfg.kind, part);
          }
          const att = await tx
            .select({ row: s.attachments })
            .from(s.attachments)
            .innerJoin(s.transactions, eq(s.attachments.transaction_id, s.transactions.id))
            .where(and(gt(s.attachments.server_version, cursor), inArray(s.transactions.ledger_id, myLedgerIds)))
            .orderBy(s.attachments.server_version)
            .limit(limit + 1);
          push('attachment', att.map((r: any) => r.row));
          const items = await tx
            .select({ row: s.budget_items })
            .from(s.budget_items)
            .innerJoin(s.budgets, eq(s.budget_items.budget_id, s.budgets.id))
            .where(and(gt(s.budget_items.server_version, cursor), inArray(s.budgets.ledger_id, myLedgerIds)))
            .orderBy(s.budget_items.server_version)
            .limit(limit + 1);
          push('budget_item', items.map((r: any) => r.row));
        }

        rows.sort((a, b) => (Number(a.row.server_version) || 0) - (Number(b.row.server_version) || 0));
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
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
