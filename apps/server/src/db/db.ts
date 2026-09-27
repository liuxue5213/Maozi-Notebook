import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
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
    return drizzlePglite(pglite, { schema }) as unknown as Db;
  }
  const pool = new pg.Pool({ connectionString: url });
  return drizzle(pool, { schema });
}

export const db = createDb(env.DATABASE_URL);
