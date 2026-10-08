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

/** 服务端 noop 判定:载荷与现有行是否完全等效(金额按数值等价,忽略同步元字段与未提供字段)。
 *  例外:is_deleted 视为有效变更——恢复(软删→未删)只改删除状态,若被跳过会被误判 noop,
 *  导致「回收站恢复/误删撤销」永远无法同步到服务端(协议缺口,2026-10-09 修复)。 */
const EFFECTIVE_META_SKIP = new Set([...META_FIELDS].filter((k) => k !== 'is_deleted'));

export function hasEffectiveChanges(server: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(incoming));
  for (const k of keys) {
    if (EFFECTIVE_META_SKIP.has(k)) continue;
    const iv = incoming[k];
    if (iv === undefined) continue;
    if (!valuesEqual(server[k], iv)) return true;
  }
  return false;
}

/** LWW 迟到载荷拒收阈值:容忍 60s 设备时钟偏差 */
const STALE_LWW_TOLERANCE_MS = 60_000;

/**
 * 无 base 旧载荷的迟到拒收(预算恢复 bug ②):
 * 升级前积压的 outbox 不带 base 快照 → 服务端退化整载荷 LWW「后推者赢」,
 * 离线积压的旧载荷会把别端较新的修改静默盖回(「预算改了又被恢复」根因之一)。
 * 判定:载荷明显更旧(updated_at 早于现存行超过阈值)且未带来更高 client_version → 判为迟到。
 * 代价:极端坏时钟下的新编辑可能被拒——本地仍保留,下次编辑带 base 后自然收敛,可接受。
 */
export function isStaleLwwPush(server: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  const serverAt = Number(server.updated_at ?? 0);
  const payloadAt = Number(incoming.updated_at ?? 0);
  if (!serverAt || !payloadAt) return false;
  if (payloadAt >= serverAt - STALE_LWW_TOLERANCE_MS) return false;
  return Number(incoming.client_version ?? 0) <= Number(server.client_version ?? 0);
}

/**
 * 三方字段级合并(第 13 轮,修复「非关键字段整载荷 LWW 静默覆盖」):
 * 以客户端编辑基线快照(base)为公共祖先逐字段对比 ——
 * - 仅客户端改 → 应用客户端值;
 * - 仅服务端改 → 保留服务端值(客户端载荷只是「没动该字段」,不得覆盖较新修改);
 * - 双方都改 → 关键字段冲突保留服务端值并入冲突清单(客户端生成冲突副本);非关键字段服务端优先。
 * base 缺省时调用方应退化为 mergeServerRow(整载荷 LWW,向后兼容旧客户端)。
 */
export function mergeThreeWay<T extends Record<string, unknown>>(
  server: T,
  incoming: T,
  base: Record<string, unknown>,
): { merged: Record<string, unknown>; conflicts: FieldConflict[] } {
  const merged: Record<string, unknown> = { ...server };
  const conflicts: FieldConflict[] = [];
  const keys = new Set([...Object.keys(server), ...Object.keys(incoming)]);
  for (const k of keys) {
    if (META_FIELDS.has(k)) continue;
    const sv = server[k];
    const iv = incoming[k];
    const bv = base[k];
    const clientChanged = !valuesEqual(iv, bv);
    const serverChanged = !valuesEqual(sv, bv);
    if (!clientChanged) continue; // 客户端未动该字段:一律保留服务端值(含并发方的较新修改)
    if (!serverChanged) {
      if (iv !== undefined) merged[k] = iv; // 仅客户端改:应用
      continue;
    }
    // 双方都改:关键字段冲突(双版本并存);非关键字段服务端优先(不丢已收敛的较新值)
    if (MANUAL_FIELDS.has(k)) conflicts.push({ field: k });
  }
  return { merged, conflicts };
}
