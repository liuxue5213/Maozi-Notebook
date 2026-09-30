import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/db';
import * as s from '../db/schema';
import { AppError } from '../common/errors';
import { lockGlobalWrite, reserveSeq, seedDefaultLedger } from '../db/bootstrap';

@Injectable()
export class LedgerService {
  async list(userId: string) {
    return db
      .select({
        id: s.ledgers.id,
        name: s.ledgers.name,
        type: s.ledgers.type,
        icon: s.ledgers.icon,
        sort: s.ledgers.sort,
        is_deleted: s.ledgers.is_deleted,
        my_role: s.ledger_members.role,
      })
      .from(s.ledger_members)
      .innerJoin(s.ledgers, eq(s.ledger_members.ledger_id, s.ledgers.id))
      .where(and(eq(s.ledger_members.user_id, userId), eq(s.ledgers.is_deleted, false)));
  }

  async create(userId: string, name: string, type: string) {
    const ledgerId = await db.transaction((tx) => seedDefaultLedger(tx, userId, name, type));
    return { id: ledgerId, name, type };
  }

  async rename(userId: string, id: string, name: string) {
    await this.assertOwner(userId, id);
    // P1-15 修复:预留序号与行更新必须在同一事务内(原实现先提交 reserve 再在事务外 update,
    // 中途失败会留下「序号已消耗但行未更新」的不一致)
    await db.transaction(async (tx) => {
      await lockGlobalWrite(tx);
      const seq = await reserveSeq(tx, 1);
      await tx.update(s.ledgers).set({ name, server_version: seq, updated_at: Date.now() }).where(eq(s.ledgers.id, id));
    });
    return { id, name };
  }

  async remove(userId: string, id: string) {
    await this.assertOwner(userId, id);
    await db.transaction(async (tx) => {
      await lockGlobalWrite(tx);
      const seq = await reserveSeq(tx, 1);
      await tx
        .update(s.ledgers)
        .set({ is_deleted: true, deleted_at: Date.now(), server_version: seq, updated_at: Date.now() })
        .where(eq(s.ledgers.id, id));
    });
    return { id, deleted: true };
  }

  private async assertOwner(userId: string, ledgerId: string): Promise<void> {
    const m = (
      await db
        .select({ role: s.ledger_members.role })
        .from(s.ledger_members)
        .where(and(eq(s.ledger_members.ledger_id, ledgerId), eq(s.ledger_members.user_id, userId), eq(s.ledger_members.is_deleted, false)))
        .limit(1)
    )[0];
    if (m?.role !== 'owner') throw new AppError('ledger.owner.403', 403, '仅账本所有者可执行该操作');
  }
}
