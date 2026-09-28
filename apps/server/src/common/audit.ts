import { newId } from '@ledgerone/domain';
import { db } from '../db/db';
import * as s from '../db/schema';

/**
 * 安全审计落库(上线全检剩余待办):登录失败/验证码锁定/refresh 轮换/403 越权统一留痕 audit_logs。
 * fire-and-forget:审计失败绝不阻断业务主流程,只记日志(灰度期监控该错误)。
 */

export interface AuditEvent {
  /** 已知操作者(登录成功后的 refresh/logout 等);未登录或身份不明时空 */
  actorUserId?: string | null;
  /** 账本类事件才有;鉴权类事件空 */
  ledgerId?: string | null;
  action: string;
  /** 对象标识(一律脱敏:掩码邮箱/手机号、请求路径等),不落明文凭据与完整 PII */
  target?: string | null;
  summary?: Record<string, unknown>;
}

/** 邮箱脱敏:前缀 ≥4 位保留前两位,否则只保留首字符(防短前缀反查,同时保留排查可读性) */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.length >= 4 ? local.slice(0, 2) : local.slice(0, 1);
  return `${head}***@${domain}`;
}

/** 手机号脱敏:保留后 4 位 */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `****${phone.slice(-4)}`;
}

export function logAudit(evt: AuditEvent): void {
  void db
    .insert(s.audit_logs)
    .values({
      id: newId(),
      ledger_id: evt.ledgerId ?? null,
      actor_user_id: evt.actorUserId ?? null,
      action: evt.action,
      target_entity: evt.target ?? null,
      summary: evt.summary ?? null,
      created_at: Date.now(),
    })
    .catch((e) => console.error('[ledgerone] audit 写入失败:', e));
}
