import { isValidAmount, type FieldConflict } from '@ledgerone/domain';

/** 关键字段:冲突时不自动裁决,保留双方版本(PRD 5.5) */
const MANUAL_FIELDS = new Set(['type', 'amount', 'happened_at', 'account_id', 'to_account_id', 'currency']);
/** 同步元字段与服务端权威字段:不参与合并 */
const META_FIELDS = new Set([
  'client_version', 'server_version', 'is_deleted', 'deleted_at', 'created_at', 'updated_at', 'user_id',
]);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** 金额字段做数值等价:'26' 与 '26.0000' 视为相等(PG numeric 定点回显带尾零);null 与 undefined 视为相等 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (deepEqual(a, b)) return true;
  if (typeof a === 'string' && typeof b === 'string' && isValidAmount(a) && isValidAmount(b)) {
    return Number(a) === Number(b);
  }
  return false;
}

/**
 * 字段级合并(PRD 5.5):
 * - 不同字段被不同端修改 → 取双方非空字段并集(显式传 null 视为「清空该字段」);
 * - 同一字段冲突 → 关键字段保留服务端值并返回冲突清单(供客户端生成冲突副本),非关键字段取客户端值。
 */
export function mergeServerRow<T extends Record<string, unknown>>(
  server: T,
  incoming: T,
): { merged: Record<string, unknown>; conflicts: FieldConflict[] } {
  const merged: Record<string, unknown> = { ...server };
  const conflicts: FieldConflict[] = [];
  const keys = new Set([...Object.keys(server), ...Object.keys(incoming)]);
  for (const k of keys) {
    if (META_FIELDS.has(k)) continue;
    const sv = server[k];
    const iv = incoming[k];
    if (valuesEqual(sv, iv)) continue;
    if (MANUAL_FIELDS.has(k)) {
      conflicts.push({ field: k });
      continue;
    }
    if (iv !== undefined) merged[k] = iv; // undefined = 客户端未提供;显式 null = 清空
  }
  return { merged, conflicts };
}

/** 服务端 noop 判定:载荷与现有行是否完全等效(金额按数值等价,忽略同步元字段与未提供字段) */
export function hasEffectiveChanges(server: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(incoming));
  for (const k of keys) {
    if (META_FIELDS.has(k)) continue;
    const iv = incoming[k];
    if (iv === undefined) continue;
    if (!valuesEqual(server[k], iv)) return true;
  }
  return false;
}
