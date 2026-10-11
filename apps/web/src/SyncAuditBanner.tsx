import { useEffect, useState } from 'react';
import { getLastSyncAudit, subscribeSyncAudit } from './sync/wiring';

/** 对账自检横幅(Q3 拍板前置):同步完成后本地 vs 服务端逐实体计数比对,
 *  不一致亮红——终结「静默分歧」。对账仅在 outbox 清空(全部定案)后执行。 */
export function SyncAuditBanner() {
  const [audit, setAudit] = useState(getLastSyncAudit());

  useEffect(() => subscribeSyncAudit(() => setAudit(getLastSyncAudit())), []);

  // O7 透明化:死信/冲突副本非零 → 琥珀色提示(不影响红色对账错误)
  const attention = (audit?.deadletter ?? 0) + (audit?.conflictCopies ?? 0);
  if (!audit) return null;
  if (!audit.ok) {
    return (
      <div role="alert" style={{ background: 'var(--expense)', color: '#fff', borderRadius: 12, padding: '10px 14px', marginBottom: 10, fontSize: 13 }}>
        ⚠️ 数据对账不一致：
        {audit.diffs.map((d) => ` ${d.entity} 本地${d.local}/服务端${d.server}`).join('；')}
        ——请点「立即同步」重试；反复出现请先导出备份
      </div>
    );
  }
  if (attention > 0) {
    return (
      <div role="status" style={{ background: '#b45309', color: '#fff', borderRadius: 12, padding: '10px 14px', marginBottom: 10, fontSize: 13 }}>
        ⓘ 有 {attention} 条记录需要确认
        {audit.deadletter > 0 ? ` · 死信 ${audit.deadletter} 条` : ''}
        {audit.conflictCopies > 0 ? ` · 冲突副本 ${audit.conflictCopies} 条` : ''}
        ——到「我的 → 安全与隐私 → 同步诊断(死信)」查看处理
      </div>
    );
  }
  return null;
}
