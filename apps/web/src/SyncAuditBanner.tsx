import { useEffect, useState } from 'react';
import { getLastSyncAudit, subscribeSyncAudit } from './sync/wiring';

/** 对账自检横幅(Q3 拍板前置):同步完成后本地 vs 服务端逐实体计数比对,
 *  不一致亮红——终结「静默分歧」。对账仅在 outbox 清空(全部定案)后执行。 */
export function SyncAuditBanner() {
  const [audit, setAudit] = useState(getLastSyncAudit());

  useEffect(() => subscribeSyncAudit(() => setAudit(getLastSyncAudit())), []);

  if (!audit || audit.ok) return null;
  return (
    <div role="alert" style={{ background: 'var(--expense)', color: '#fff', borderRadius: 12, padding: '10px 14px', marginBottom: 10, fontSize: 13 }}>
      ⚠️ 数据对账不一致：
      {audit.diffs.map((d) => ` ${d.entity} 本地${d.local}/服务端${d.server}`).join('；')}
      ——请点「立即同步」重试；反复出现请先导出备份
    </div>
  );
}
