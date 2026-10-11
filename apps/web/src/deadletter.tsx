import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import { confirmDialog } from './ui/dialog';
import { getLastSyncAudit } from './sync/wiring';

/**
 * 同步诊断(P1-20,Review 2C):死信列表 —— 被服务端拒绝的变更此前对用户完全不可见。
 * 展示实体/原因/时间,支持导出 JSON 排查与一键清空;不含 payload 明细(排查用导出)。
 */
export function DeadLetterSection() {
  const letters = useLiveQuery(async () => (await db.deadletter.orderBy('at').reverse().toArray()).slice(0, 20), []);
  const conflictCopies = useLiveQuery(async () => db.transactions.filter((t) => String(t.id).startsWith('conflict_') && !t.is_deleted).count(), []);
  const audit = getLastSyncAudit();

  // 完全干净:无死信、无冲突副本、对账一致 → 保持原样隐藏整个区块
  const clean = !letters?.length && !(audit && !audit.ok) && !(conflictCopies ?? 0);
  if (clean) return null;

  const exportJson = (): void => {
    void db.deadletter.toArray().then((rows) => {
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ledgerone-deadletter-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    });
  };

  const clearAll = async (): Promise<void> => {
    if (!(await confirmDialog({ message: `清空 ${letters?.length ?? 0} 条死信记录?对应修改不会重试,如需排查请先导出。`, danger: true, confirmText: '清空' }))) return;
    await db.deadletter.clear();
  };

  return (
    <div className="me-section">
      {audit && !audit.ok && (
        <div className="me-row static-row" style={{ color: 'var(--expense)' }}>
          <span>⚠️ 最近对账不一致</span>
          <span className="muted">
            {audit.diffs.map((d) => `${d.entity} 本地${d.local}/服务端${d.server}`).join('；')} — 点「立即同步」重试
          </span>
        </div>
      )}
      {(conflictCopies ?? 0) > 0 && (
        <div className="me-row static-row">
          <span>冲突副本</span>
          <span className="muted">{conflictCopies} 条(关键字段冲突时保留的你的版本,在明细中带[冲突副本]标记)</span>
        </div>
      )}
      <div className="me-row static-row">
        <span>同步死信</span>
        <span className="muted">{letters?.length ?? 0} 条未入云的修改</span>
      </div>
      {letters?.map((l: { id?: number; entity: string; at: number; reason?: string }) => (
        <div key={l.id} className="me-row static-row">
          <span className="muted small">
            {l.entity} · {new Date(l.at).toLocaleString('zh-CN')}
            <span style={{ display: 'block' }}>{l.reason?.slice(0, 60) ?? '服务端拒收'}</span>
          </span>
        </div>
      ))}
      <div className="me-row static-row">
        <span className="muted small">被拒收的修改不自动重试;可导出排查后在本机修正重录</span>
        <span>
          <button className="mini" onClick={exportJson}>导出</button>{' '}
          <button className="mini danger-text" onClick={() => void clearAll()}>清空</button>
        </span>
      </div>
    </div>
  );
}
