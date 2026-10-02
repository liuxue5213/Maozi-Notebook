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
    withExclusiveTransactionAsync: (task: (tx: unknown) => Promise<void>) => Promise<void>;
  };
  return {
    execAsync: (sql) => c.execAsync(sql),
    runAsync: (sql, params) => c.runAsync(sql, params),
    getAllAsync: <T>(sql: string, params?: unknown[]) => c.getAllAsync<T>(sql, params),
    withExclusiveTransactionAsync: (task) => c.withExclusiveTransactionAsync((tx) => task(wrap(tx))),
  };
}

/** SecureStore 兜底超时:个别国产 ROM 的 Keystore 会无响应挂起(不抛错),必须带超时暴露 */
async function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`安全区访问超时(${tag},${ms}ms)——多为系统 Keystore 无响应,请重启手机后重试`)), ms)),
  ]);
}

/** 整库加密密钥:随机 32 字节 hex,只存系统安全区(iOS Keychain / Android Keystore) */
async function loadDbKey(): Promise<string> {
  console.log('[boot] keystore:get:start');
  let key = await withTimeout(SecureStore.getItemAsync(DB_KEY_STORE), 4000, 'read');
  console.log('[boot] keystore:get:done');
  if (!key) {
    const bytes = await Crypto.getRandomBytesAsync(32);
    key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await withTimeout(SecureStore.setItemAsync(DB_KEY_STORE, key), 4000, 'write');
    console.log('[boot] keystore:set:done');
  }
  return key;
}

let real: SQLiteLike | null = null;

/**
 * 打开加密库(F-05 / M16-F02):
 * 1) app.json 配置 expo-sqlite 插件 useSQLCipher:true(编译期启用 SQLCipher);
 * 2) 打开后第一条语句必须是 PRAGMA key(SQLCipher 约定),密钥为 SecureStore 中的 32 字节 raw key。
 * P0-7(第 27 轮):PRAGMA key 后执行 sqlite_master 握手 —— 密钥错误/库损坏时立刻抛错,
 * 而不是等到首次业务查询才失败(initDb 缓存 rejected promise 导致永久白屏)。
 */
export async function initEncryptedDb(): Promise<void> {
  if (real) return;
  const key = await loadDbKey();
  console.log('[boot] sqlite:open');
  const conn = SQLite.openDatabaseSync('ledgerone.db');
  await conn.execAsync(`PRAGMA key = "x'${key}'";`);
  console.log('[boot] sqlite:pragma-key:ok');
  await conn.execAsync('SELECT count(*) FROM sqlite_master'); // 握手:密钥/库完整性即时校验
  console.log('[boot] sqlite:handshake:ok');
  real = wrap(conn);
}

/** P0-7 自愈:删除本地库文件(密钥错乱/库损坏时由用户显式触发,重置后重新播种) */
export async function resetLocalDatabase(): Promise<void> {
  real = null;
  try {
    SQLite.openDatabaseSync('ledgerone.db').execSync('PRAGMA close;');
  } catch {
    /* 可能未打开 */
  }
  try {
    SQLite.deleteDatabaseSync?.('ledgerone.db');
  } catch {
    /* 文件可能不存在 */
  }
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
