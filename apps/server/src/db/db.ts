import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migrateNode } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import pg from 'pg';
import { env } from '../env';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

/**
 * DATABASE_URL 支持两种形态:
 * - postgres://…  标准 PostgreSQL(node-postgres 连接池)
 * - pglite://<目录> 嵌入式 PGlite(零配置开发/冒烟,见 docker-compose.yml 与 .env.example)
 */
export function createDb(url: string): Db {
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    const pglite = !target || target === 'memorydb' ? new PGlite() : new PGlite(target);
    closable = pglite; // 优雅停机用(第 5 轮:PGlite 被 SIGKILL 后库文件无法再打开)
    return drizzlePglite(pglite, { schema }) as unknown as Db;
  }
  const pool = new pg.Pool({ connectionString: url });
  closable = { close: () => pool.end() }; // pg.Pool 的关闭语义是 end()
  return drizzle(pool, { schema });
}

let closable: { close: () => Promise<void> } | null = null;

/** 优雅停机:关闭底层连接(PGlite 落盘收尾 / PG 连接池),避免强杀损坏库文件 */
export async function closeDb(): Promise<void> {
  const c = closable;
  closable = null;
  await c?.close();
}

export const db = createDb(env.DATABASE_URL);

/**
 * 启动即应用版本化迁移(第 5 轮 E2E 发现:dev/存量库此前只能靠手动 db:push,
 * 漏执行会让新列缺失、fire-and-forget 写入(如审计)静默失败)。
 * - 全新库:完整执行迁移链;
 * - 已有迁移基线的库:增量执行(drizzle 记账幂等,重复无害);
 * - 存量 db:push 建的库(有表但无基线):无法判定增量,明确告警并跳过,引导执行一次 db:push。
 */
export async function runMigrations(): Promise<void> {
  const folder = path.resolve(process.cwd(), 'drizzle');
  const baseline = (
    await db.execute(
      sql`select exists (select 1 from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations') as ok`,
    )
  ).rows[0] as { ok: boolean };
  const coreTables = (
    await db.execute(
      sql`select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'users') as ok`,
    )
  ).rows[0] as { ok: boolean };
  if (!baseline.ok && coreTables.ok) {
    console.warn('[ledgerone] 存量库未建立迁移基线,已跳过自动迁移;请执行一次 `pnpm db:push` 对齐 schema');
    return;
  }
  if (env.DATABASE_URL.startsWith('pglite://')) {
    await migratePglite(db as never, { migrationsFolder: folder });
  } else {
    await migrateNode(db as never, { migrationsFolder: folder });
  }
}
