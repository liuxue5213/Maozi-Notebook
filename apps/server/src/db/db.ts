import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { env } from '../env';
import * as schema from './schema';

export type Db = MySql2Database<typeof schema>;

const pool = mysql.createPool({ uri: env.DATABASE_URL, decimalNumbers: false });
export const db: Db = drizzle({ client: pool, schema, mode: 'default' });

export async function closeDb(): Promise<void> {
  await pool.end();
}

/** Startup migrations use a dedicated connection so every migration uses one session. */
export async function runMigrations(): Promise<void> {
  const connection = await mysql.createConnection(env.DATABASE_URL);
  try {
    const [tables] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('users', '__drizzle_migrations')",
    );
    // MySQL 8.4 列标签大小写不稳定(MariaDB 恒小写),按行值归一而非按键取
    const names = new Set(tables.map((row) => String(Object.values(row)[0]).toLowerCase()));
    if (names.has('users') && !names.has('__drizzle_migrations')) {
      throw new Error('MySQL 库已有 users 表但没有迁移记录;请先备份并使用空库执行新迁移');
    }
    const migrationDb = drizzle({ client: connection, schema, mode: 'default' });
    await migrate(migrationDb, { migrationsFolder: path.resolve(process.cwd(), 'drizzle-mysql') });
  } finally {
    await connection.end();
  }
}
