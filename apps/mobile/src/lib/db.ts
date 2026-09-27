import * as SQLite from 'expo-sqlite';
import type { SQLiteLike } from '@ledgerone/sqlite-sync';

/**
 * 本地库:expo-sqlite。
 * M16-F02 整库加密:SDK 57 需在 app.json 配置 expo-sqlite 插件开启 SQLCipher 后,
 * 用 openDatabaseSync 的加密选项/encryptAsync;当前骨架先以明文库落地,密钥管理 TODO(SecureStore)。
 */
function wrap(d: unknown): SQLiteLike {
  const c = d as {
    execAsync: (sql: string) => Promise<unknown>;
    runAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
    getAllAsync: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  };
  return {
    execAsync: (sql) => c.execAsync(sql),
    runAsync: (sql, params) => c.runAsync(sql, params),
    getAllAsync: <T>(sql: string, params?: unknown[]) => c.getAllAsync<T>(sql, params),
  };
}

export const db: SQLiteLike = wrap(SQLite.openDatabaseSync('ledgerone.db'));
