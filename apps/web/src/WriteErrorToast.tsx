import { useEffect, useState } from 'react';
import { subscribeWriteErrors } from './sync/wiring';

/** O4 全局写入失败提示:saveLocal 的任何静默失败(原 `void saveLocal(...)` 调用方)在此统一可见,
 *  8 秒自动消退;与各页面自身 toast 独立,互不影响。 */
export function WriteErrorToast() {
  const [err, setErr] = useState<{ entity: string; message: string } | null>(null);

  useEffect(() => subscribeWriteErrors((e) => setErr({ entity: e.entity, message: e.message })), []);

  useEffect(() => {
    if (!err) return;
    const t = setTimeout(() => setErr(null), 8000);
    return () => clearTimeout(t);
  }, [err]);

  if (!err) return null;
  return (
    <div className="toast" role="alert" style={{ background: 'var(--expense)', color: '#fff', zIndex: 300 }}>
      ⚠️ 本地写入失败（{err.entity}）：{err.message} —— 数据未保存，请重试或先导出备份
    </div>
  );
}
