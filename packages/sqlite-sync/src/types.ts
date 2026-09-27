/** 与具体驱动无关的最小 SQLite 异步接口:expo-sqlite 与 node:sqlite 均可适配 */
export interface SQLiteLike {
  execAsync(sql: string): Promise<unknown>;
  runAsync(sql: string, params?: unknown[]): Promise<unknown>;
  getAllAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export type AnyRow = Record<string, unknown>;
