import { describe, expect, it } from 'vitest';
import { mergeServerRow } from '../src/merge';

describe('字段级合并(PRD 5.5)', () => {
  const server = {
    id: 't1', amount: '26', happened_at: 1_000, note: '咖啡', account_id: 'a1',
    type: 'expense' as const, client_version: 2, server_version: 5,
    is_deleted: false, created_at: 1, updated_at: 1, user_id: 'u1',
  };

  it('不同字段被不同端修改 → 非空并集', () => {
    const incoming = { ...server, note: '拿铁', amount: '26' };
    const { merged, conflicts } = mergeServerRow(server, incoming);
    expect(merged.note).toBe('拿铁');
    expect(conflicts).toHaveLength(0);
  });

  it('同一关键字段冲突 → 保留服务端值并返回冲突', () => {
    const incoming = { ...server, amount: '30', note: '拿铁' };
    const { merged, conflicts } = mergeServerRow(server, incoming);
    expect(merged.amount).toBe('26');
    expect(merged.note).toBe('拿铁');
    expect(conflicts).toEqual([{ field: 'amount' }]);
  });

  it('同步元字段不参与合并', () => {
    const incoming = { ...server, server_version: 999, updated_at: 999, user_id: 'evil' };
    const { merged, conflicts } = mergeServerRow(server, incoming);
    expect(merged.server_version).toBe(5);
    expect(merged.user_id).toBe('u1');
    expect(conflicts).toHaveLength(0);
  });

  it('完全相同 → 无冲突', () => {
    const { conflicts } = mergeServerRow(server, server);
    expect(conflicts).toHaveLength(0);
  });

  it('金额定点等价:26 与 26.0000 不算冲突(PG numeric 回显尾零)', () => {
    const incoming = { ...server, amount: '26.0000', note: '咖啡' };
    const { merged, conflicts } = mergeServerRow({ ...server, amount: '26' }, incoming);
    expect(conflicts).toHaveLength(0);
    expect(merged.amount).toBe('26');
  });

  it('金额数值不同才算冲突', () => {
    const incoming = { ...server, amount: '26.0001' };
    const { conflicts } = mergeServerRow({ ...server, amount: '26' }, incoming);
    expect(conflicts.map((c) => c.field)).toContain('amount');
  });

  it('null 与 undefined 等价,不产生幻影冲突(可选字段缺省)', () => {
    const { server: row } = { server: { ...server, to_account_id: null } };
    const incoming = { ...row } as typeof row;
    delete (incoming as Record<string, unknown>).to_account_id;
    const { conflicts } = mergeServerRow(row, incoming);
    expect(conflicts).toHaveLength(0);
  });
});

describe('显式 null 应用(清空字段)', () => {
  const server = {
    id: 't1', amount: '26', happened_at: 1_000, note: '咖啡', account_id: 'a1',
    type: 'expense' as const, client_version: 2, server_version: 5,
    is_deleted: false, created_at: 1, updated_at: 1, user_id: 'u1',
  };
  it('客户端显式 null → 服务端字段被清空', () => {
    const { merged, conflicts } = mergeServerRow({ ...server, note: '旧备注' }, { ...server, note: null });
    expect(conflicts).toHaveLength(0);
    expect(merged.note).toBeNull();
  });
});

describe('hasEffectiveChanges(noop 判定)', () => {
  const server = {
    id: 't1', amount: '26', happened_at: 1_000, note: '咖啡', account_id: 'a1',
    type: 'expense' as const, client_version: 2, server_version: 5,
    is_deleted: false, created_at: 1, updated_at: 1, user_id: 'u1',
  };
  it('同载荷 false;字段不同 true;元字段与 undefined 忽略;金额数值等价不算变更', async () => {
    const { hasEffectiveChanges } = await import('../src/merge');
    expect(hasEffectiveChanges({ ...server }, { ...server })).toBe(false);
    expect(hasEffectiveChanges({ ...server }, { ...server, note: '新' })).toBe(true);
    expect(hasEffectiveChanges({ ...server }, { ...server, server_version: 999, client_version: 99 })).toBe(false);
    expect(hasEffectiveChanges({ ...server }, { ...server, member_id: undefined })).toBe(false);
    expect(hasEffectiveChanges({ ...server, amount: '26.0000' }, { ...server, amount: '26' })).toBe(false);
  });
});
