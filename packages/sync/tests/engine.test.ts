import { describe, expect, it, vi } from 'vitest';
import type { ChangeOp, PullResponse, PushResponse, SyncTransport } from '@ledgerone/domain';
import { SyncEngine, type ChangeQueue, type RowSink } from '../src/engine';

function makeFakes() {
  const queue: ChangeOp[] = [];
  const applied: Array<[string, Record<string, unknown>]> = [];
  let cursor = 0;
  const pushed: ChangeOp[][] = [];
  const transport: SyncTransport = {
    push: async (changes) => {
      pushed.push(changes);
      const res: PushResponse = {
        results: changes.map((c) => ({ entityId: c.entityId, status: 'applied' as const, serverVersion: ++cursor })),
      };
      return res;
    },
    pull: async (): Promise<PullResponse> => ({
      cursor,
      hasMore: false,
      rows: [
        { entity: 'transaction', row: { id: 'srv-1', amount: '10', server_version: cursor, client_version: 3 } },
        { entity: 'category', row: { id: 'cat-1', name: '餐饮', server_version: cursor, client_version: 1 } },
      ],
    }),
  };
  const changeQueue: ChangeQueue = {
    take: async (n) => queue.slice(0, n),
    ack: async (seqs) => {
      for (const s of seqs) {
        const i = queue.findIndex((q) => q.seq === s);
        if (i >= 0) queue.splice(i, 1);
      }
    },
    count: async () => queue.length,
  };
  const sink: RowSink = {
    applyServerRow: async (entity, row) => {
      applied.push([entity, row]);
    },
    getCursor: async () => cursor,
    setCursor: async (c) => {
      cursor = c;
    },
  };
  return { queue, applied, pushed, transport, changeQueue, sink, getCursor: () => cursor };
}

describe('SyncEngine', () => {
  it('推空队列后拉取落地并推进游标', async () => {
    const f = makeFakes();
    const engine = new SyncEngine({ transport: f.transport, queue: f.changeQueue, sink: f.sink });
    await engine.syncOnce();
    expect(f.pushed).toHaveLength(0);
    expect(f.applied.map(([e]) => e)).toEqual(['transaction', 'category']);
    expect(engine.getSnapshot().state).toBe('idle');
    expect(engine.getSnapshot().lastSyncAt).not.toBeNull();
  });

  it('推送后清空待同步队列', async () => {
    const f = makeFakes();
    f.queue.push(
      { seq: 1, entity: 'transaction', entityId: 't1', op: 'upsert', payload: { id: 't1' }, clientVersion: 1, occurredAt: Date.now() },
      { seq: 2, entity: 'transaction', entityId: 't2', op: 'upsert', payload: { id: 't2' }, clientVersion: 1, occurredAt: Date.now() },
    );
    const engine = new SyncEngine({ transport: f.transport, queue: f.changeQueue, sink: f.sink });
    await engine.syncOnce();
    expect(f.queue).toHaveLength(0);
    expect(engine.getSnapshot().pending).toBe(0);
  });

  it('rejected 结果走死信回调且出队(不阻塞后续)', async () => {
    const f = makeFakes();
    f.queue.push({ seq: 1, entity: 'transaction', entityId: 'bad', op: 'upsert', payload: { id: 'bad' }, clientVersion: 1, occurredAt: Date.now() });
    f.queue.push({ seq: 2, entity: 'transaction', entityId: 'good', op: 'upsert', payload: { id: 'good' }, clientVersion: 1, occurredAt: Date.now() });
    const origPush = f.transport.push.bind(f.transport);
    f.transport.push = async (changes) => {
      const res = await origPush(changes);
      res.results[0] = { ...res.results[0], status: 'rejected' as const, reason: 'payload invalid' };
      return res;
    };
    const dead: Array<{ id: string; reason?: string }> = [];
    const engine = new SyncEngine({
      transport: f.transport, queue: f.changeQueue, sink: f.sink,
      onDeadLetter: async (op, reason) => { dead.push({ id: op.entityId, reason }); },
    });
    await engine.syncOnce();
    expect(dead).toEqual([{ id: 'bad', reason: 'payload invalid' }]);
    expect(await f.changeQueue.count()).toBe(0); // rejected 死信后出队,后续 op 已正常上行
    expect(engine.getSnapshot().state).toBe('idle');
  });

  it('push 失败不影响 pull 落地', async () => {
    const f = makeFakes();
    f.queue.push({ seq: 1, entity: 'transaction', entityId: 't9', op: 'upsert', payload: { id: 't9' }, clientVersion: 1, occurredAt: Date.now() });
    f.transport.push = async () => { throw new Error('network down'); };
    const engine = new SyncEngine({ transport: f.transport, queue: f.changeQueue, sink: f.sink });
    await engine.syncOnce();
    expect(f.applied.length).toBe(2); // pull 照常落地
    expect(engine.getSnapshot().state).toBe('error');
    expect(await f.changeQueue.count()).toBe(1); // push 队列保留待下轮重试
  });

  it('冲突结果触发 onPushConflict 回调', async () => {
    const f = makeFakes();
    f.queue.push({ seq: 1, entity: 'transaction', entityId: 't1', op: 'upsert', payload: { id: 't1' }, clientVersion: 3, occurredAt: Date.now() });
    const origPush = f.transport.push.bind(f.transport);
    f.transport.push = async (changes) => {
      const res = await origPush(changes);
      res.results[0] = { ...res.results[0], status: 'conflict', conflicts: [{ field: 'amount', serverValue: '26', clientValue: '30' }] };
      return res;
    };
    const onConflict = vi.fn();
    const engine = new SyncEngine({ transport: f.transport, queue: f.changeQueue, sink: f.sink, onPushConflict: onConflict });
    await engine.syncOnce();
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(f.queue).toHaveLength(0); // 冲突同样 ack,由回调生成副本
  });

  it('传输失败进入 error 状态且不清队列', async () => {
    const f = makeFakes();
    f.queue.push({ seq: 1, entity: 'transaction', entityId: 't1', op: 'upsert', payload: { id: 't1' }, clientVersion: 1, occurredAt: Date.now() });
    f.transport.push = async () => {
      throw new Error('network down');
    };
    const engine = new SyncEngine({ transport: f.transport, queue: f.changeQueue, sink: f.sink });
    await engine.syncOnce();
    expect(engine.getSnapshot().state).toBe('error');
    expect(engine.getSnapshot().pending).toBe(1);
  });
});
