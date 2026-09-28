import { describe, expect, it } from 'vitest';
import { mergeServerRow, mergeThreeWay } from '../src/merge';

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

describe('三方字段级合并(第 13 轮,mergeThreeWay)', () => {
  const base = {
    id: 't1', amount: '26.0000', happened_at: 1_000, note: '原文', account_id: 'a1',
    type: 'expense' as const, category_id: 'c1', client_version: 2, server_version: 5,
    is_deleted: false, created_at: 1, updated_at: 1, user_id: 'u1',
  };
  const serverNow = { ...base, server_version: 9 };

  it('陈旧非关键字段不再覆盖较新修改:A 携旧备注 × B 已改备注 → 服务端备注保留', () => {
    // A 离线前的旧载荷(备注还是 base 值),但服务端备注已被 B 改为「B 的备注」
    const server = { ...serverNow, note: 'B 的备注' };
    const incoming = { ...serverNow, amount: '30', note: '原文' }; // A 只想改金额,载荷带着旧备注
    const { merged, conflicts } = mergeThreeWay(server, incoming, base);
    expect(merged.note).toBe('B 的备注'); // 旧 LWW 会在此处覆盖为「原文」(第 12 轮发现)
    expect(conflicts).toHaveLength(0);
  });

  it('仅客户端改的非关键字段 → 应用客户端值', () => {
    const incoming = { ...serverNow, note: 'A 的新备注' };
    const { merged, conflicts } = mergeThreeWay(serverNow, incoming, base);
    expect(merged.note).toBe('A 的新备注');
    expect(conflicts).toHaveLength(0);
  });

  it('双方都改非关键字段 → 服务端优先(不丢已收敛值)', () => {
    const server = { ...serverNow, note: 'B 的备注' };
    const incoming = { ...serverNow, note: 'A 的备注' };
    const { merged, conflicts } = mergeThreeWay(server, incoming, base);
    expect(merged.note).toBe('B 的备注');
    expect(conflicts).toHaveLength(0); // 非关键字段并发改:服务端优先,不产生副本
  });

  it('双方都改关键字段 → 冲突清单(双版本并存);仅客户端改关键字段 → 无冲突直接应用', () => {
    const both = mergeThreeWay({ ...serverNow, amount: '50' }, { ...serverNow, amount: '30' }, base);
    expect(both.conflicts).toEqual([{ field: 'amount' }]);
    expect(both.merged.amount).toBe('50'); // 服务端保留

    const clientOnly = mergeThreeWay(serverNow, { ...serverNow, amount: '30' }, base);
    expect(clientOnly.conflicts).toHaveLength(0);
    expect(clientOnly.merged.amount).toBe('30');
  });

  it('金额数值等价参与判定:base「26」与 server「26.0000」视为未变更', () => {
    const server = { ...serverNow, amount: '26' }; // 回读带尾零差异
    const incoming = { ...serverNow, amount: '26.0000', note: 'A 改的备注' };
    const { merged, conflicts } = mergeThreeWay(server, incoming, base);
    expect(merged.note).toBe('A 改的备注'); // 金额不被误判为「服务端也改了」
    expect(conflicts).toHaveLength(0);
  });

  it('显式 null 清空字段:仅客户端清空 → 应用 null', () => {
    const incoming = { ...serverNow, note: null };
    const { merged } = mergeThreeWay(serverNow, incoming, base);
    expect(merged.note).toBeNull();
  });
});
