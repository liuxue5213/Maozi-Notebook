import type {
  ChangeOp, EntityKind, PullResponse, PushChangeResult, SyncState, SyncTransport,
} from '@ledgerone/domain';

/** 本地变更队列(outbox)的存储适配接口,Dexie / SQLite 各自实现 */
export interface ChangeQueue {
  take(limit: number): Promise<ChangeOp[]>;
  ack(seq: number[]): Promise<void>;
  count(): Promise<number>;
}

/** 服务端下行的落地适配:字段级守卫(有本地待推送版本时跳过服务端覆盖)由实现方处理 */
export interface RowSink {
  applyServerRow(entity: EntityKind, row: Record<string, unknown>): Promise<void>;
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
}

export interface SyncEngineSnapshot {
  state: SyncState;
  pending: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface SyncEngineDeps {
  transport: SyncTransport;
  queue: ChangeQueue;
  sink: RowSink;
  /** 关键字段冲突回调:实现方生成「冲突副本」保留客户端版本(PRD 5.5 双版本并存) */
  onPushConflict?: (op: ChangeOp, conflicts: PushChangeResult['conflicts']) => Promise<void>;
  /** 服务端 rejected 的 op(数据非法等):调用方应移入死信隔离,不再重试 */
  onDeadLetter?: (op: ChangeOp, reason?: string) => Promise<void>;
  batchSize?: number;
  pullBatchSize?: number;
}

export class SyncEngine {
  private snapshot: SyncEngineSnapshot = { state: 'idle', pending: 0, lastSyncAt: null, lastError: null };
  private listeners = new Set<() => void>();
  private running = false;

  constructor(private deps: SyncEngineDeps) {}

  getSnapshot = (): SyncEngineSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(patch: Partial<SyncEngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((f) => f());
  }

  private async refreshPending(): Promise<void> {
    this.emit({ pending: await this.deps.queue.count() });
  }

  async syncOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.emit({ state: 'syncing', lastError: null });
      // push 失败不阻断 pull(可先把服务端下行落地,本地队列留在 outbox 下轮重试)
      let firstError: unknown = null;
      try {
        await this.pushAll();
      } catch (e) {
        firstError = e;
      }
      try {
        await this.pullAll();
      } catch (e) {
        firstError = firstError ?? e;
      }
      if (firstError) throw firstError;
      this.emit({ state: 'idle', lastSyncAt: Date.now() });
    } catch (e) {
      this.emit({ state: 'error', lastError: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
      await this.refreshPending();
    }
  }

  private async pushAll(): Promise<void> {
    for (;;) {
      const batch = await this.deps.queue.take(this.deps.batchSize ?? 100);
      if (!batch.length) break;
      const res = await this.deps.transport.push(batch);
      const ackSeq: number[] = [];
      // 服务端按上行顺序返回结果(见 apps/server sync.service)
      res.results.forEach((r, i) => {
        const op = batch[i];
        if (op.seq !== undefined) ackSeq.push(op.seq);
        if (r.status === 'conflict' && this.deps.onPushConflict && r.conflicts?.length) {
          void this.deps.onPushConflict(op, r.conflicts);
        }
        if (r.status === 'rejected') {
          void this.deps.onDeadLetter?.(op, r.reason);
        }
      });
      // applied/noop/stale/conflict/rejected 均视为「本轮已定案」出队;rejected 已死信隔离
      await this.deps.queue.ack(ackSeq);
      await this.refreshPending();
    }
  }

  private async pullAll(): Promise<void> {
    for (;;) {
      const cursor = await this.deps.sink.getCursor();
      const res: PullResponse = await this.deps.transport.pull(cursor, this.deps.pullBatchSize ?? 500);
      for (const { entity, row } of res.rows) {
        await this.deps.sink.applyServerRow(entity, row);
      }
      await this.deps.sink.setCursor(res.cursor);
      if (!res.hasMore) break;
    }
  }
}

/** 定时同步:默认 5 分钟(PRD 5.4 同步时机) */
export function startAutoSync(
  engine: SyncEngine,
  opts: { intervalMs?: number; isOnline?: () => boolean } = {},
): () => void {
  const interval = setInterval(() => {
    if (!opts.isOnline || opts.isOnline()) void engine.syncOnce();
  }, opts.intervalMs ?? 5 * 60_000);
  return () => clearInterval(interval);
}
