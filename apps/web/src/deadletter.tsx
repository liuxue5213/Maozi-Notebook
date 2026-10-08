import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import { confirmDialog } from './ui/dialog';

/**
 * 同步诊断(P1-20,Review 2C):死信列表 —— 被服务端拒绝的变更此前对用户完全不可见。
 * 展示实体/原因/时间,支持导出 JSON 排查与一键清空;不含 payload 明细(排查用导出)。
 */
export function DeadLetterSection() {
  const letters = useLiveQuery(async () => (await db.deadletter.orderBy('at').reverse().toArray()).slice(0, 20), []);
  if (!letters?.length) return null;

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
    if (!(await confirmDialog({ message: `清空 ${letters.length} 条死信记录?对应修改不会重试,如需排查请先导出。`, danger: true, confirmText: '清空' }))) return;
    await db.deadletter.clear();
  };

  return (
    <div className="me-section">
      <div className="me-row static-row">
        <span>同步死信</span>
        <span className="muted">{letters.length} 条未入云的修改</span>
      </div>
      {letters.map((l: { id?: number; entity: string; at: number; reason?: string }) => (
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
