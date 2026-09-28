import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { SQLiteLike } from '@ledgerone/sqlite-sync';

const DB_KEY_STORE = 'lo_db_key';

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

/** 整库加密密钥:随机 32 字节 hex,只存系统安全区(iOS Keychain / Android Keystore) */
async function loadDbKey(): Promise<string> {
  let key = await SecureStore.getItemAsync(DB_KEY_STORE);
  if (!key) {
    const bytes = await Crypto.getRandomBytesAsync(32);
    key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(DB_KEY_STORE, key);
  }
  return key;
}

let real: SQLiteLike | null = null;

/**
 * 打开加密库(F-05 / M16-F02):
 * 1) app.json 配置 expo-sqlite 插件 useSQLCipher:true(编译期启用 SQLCipher);
 * 2) 打开后第一条语句必须是 PRAGMA key(SQLCipher 约定),密钥为 SecureStore 中的 32 字节 raw key。
 * 注意:此前以明文创建的旧库无法用密钥打开(「file is not a database」),需卸载重装/删库重来 —— 当前骨架未发布,无迁移负担。
 */
export async function initEncryptedDb(): Promise<void> {
  if (real) return;
  const key = await loadDbKey();
  const conn = SQLite.openDatabaseSync('ledgerone.db');
  await conn.execAsync(`PRAGMA key = "x'${key}'";`);
  real = wrap(conn);
}

/**
 * 本地库句柄:惰性代理,initEncryptedDb() 完成前访问即抛错(启动流程保证先 await initDb())。
 */
export const db: SQLiteLike = new Proxy({} as SQLiteLike, {
  get(_target, prop, receiver) {
    if (!real) throw new Error('db 未初始化:必须先 await initDb()');
    const value = Reflect.get(real as object, prop, receiver);
    return typeof value === 'function' ? (value as (this: unknown, ...args: unknown[]) => unknown).bind(real) : value;
  },
});
