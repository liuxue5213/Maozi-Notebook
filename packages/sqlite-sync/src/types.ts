/** 与具体驱动无关的最小 SQLite 异步接口:expo-sqlite 与 node:sqlite 均可适配 */
export interface SQLiteLike {
  execAsync(sql: string): Promise<unknown>;
  runAsync(sql: string, params?: unknown[]): Promise<unknown>;
  getAllAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Expo SQLite 的独占事务;回调内使用事务句柄,避免异步调用穿插。 */
  withExclusiveTransactionAsync?(task: (tx: SQLiteLike) => Promise<void>): Promise<void>;
}

export type AnyRow = Record<string, unknown>;
