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
  /** 返回 false 表示本地待推送版本阻止了落地;引擎不得跨过该行推进游标。 */
  applyServerRow(entity: EntityKind, row: Record<string, unknown>): Promise<boolean | void>;
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

  /**
   * 单轮同步。opts.pullFirst:先拉后推——用于「全新安装后首次登录」:
   * 默认先推会把本地播种的空壳账本上行,在服务端制造幽灵账本并让两端各锁各的账本;
   * 先拉后推 + beforePush 钩子丢弃从未上行的本地种子,从引擎层关闭幽灵账本工厂。
   * 注意:上行未定案时不能推进下行游标(待推送行会被 RowSink 跳过造成永久漏拉),
   * 因此 pullFirst 仅限首登空库场景(cursor=0 时无未定案上行)。
   */
  async syncOnce(opts?: { pullFirst?: boolean; beforePush?: () => Promise<void> }): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.emit({ state: 'syncing', lastError: null });
      if (opts?.pullFirst) {
        await this.pullAll();
        if (opts.beforePush) await opts.beforePush();
        await this.pushAll();
      } else {
        // 上行未定案时不能推进下行游标:待推送行会被 RowSink 跳过,之后可能永久漏拉。
        await this.pushAll();
        await this.pullAll();
      }
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
      if (res.results.length !== batch.length) throw new Error('服务端同步结果数量与上行批次不一致');
      for (const [i, r] of res.results.entries()) {
        const op = batch[i];
        if (r.entityId !== op.entityId) throw new Error('服务端同步结果与上行顺序不一致');
        if (r.status === 'conflict') {
          if (!this.deps.onPushConflict) throw new Error('缺少同步冲突处理器');
          await this.deps.onPushConflict(op, r.conflicts);
        }
        if (r.status === 'rejected') {
          if (!this.deps.onDeadLetter) throw new Error('缺少同步死信处理器');
          await this.deps.onDeadLetter(op, r.reason);
        }
        if (op.seq !== undefined) ackSeq.push(op.seq);
      }
      // applied/noop/stale/conflict/rejected 均视为「本轮已定案」出队;rejected 已死信隔离
      await this.deps.queue.ack(ackSeq);
      await this.refreshPending();
    }
  }

  private async pullAll(): Promise<void> {
    for (;;) {
      const cursor = await this.deps.sink.getCursor();
      const res: PullResponse = await this.deps.transport.pull(cursor, this.deps.pullBatchSize ?? 500);
      let safeCursor = cursor;
      for (const { entity, row } of res.rows) {
        if (await this.deps.sink.applyServerRow(entity, row) === false) {
          await this.deps.sink.setCursor(safeCursor);
          return;
        }
        safeCursor = Number(row.server_version ?? safeCursor);
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
