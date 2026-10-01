import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const adminUrl = process.env.TEST_MYSQL_URL ?? 'mysql://root:test-root@127.0.0.1:3306/mysql';
const serverDir = resolve(import.meta.dirname, '..');

it('将旧 PGlite 备份完整导入 MySQL，并拒绝重复导入', async () => {
  const dbName = `ledgerone_migrate_${process.pid}_${Date.now()}`;
  const workDir = await mkdtemp(resolve(tmpdir(), 'ledgerone-migrate-test-'));
  const sourceDir = resolve(workDir, 'source');
  const targetUrl = new URL(adminUrl);
  targetUrl.pathname = `/${dbName}`;
  const admin = await mysql.createConnection(adminUrl);
  let target: mysql.Connection | undefined;

  try {
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    target = await mysql.createConnection(targetUrl.toString());
    await migrate(drizzle({ client: target }), { migrationsFolder: resolve(serverDir, 'drizzle-mysql') });
    // 迁移后立即断言脚本依赖的元表已就绪(否则脚本侧报"尚未迁移"难定位)
    const [tbls] = await target.query<mysql.RowDataPacket[]>(
      'SELECT table_name AS tn FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    const names = tbls.map((r) => String(r.tn));
    expect(names).toEqual(expect.arrayContaining(['__drizzle_migrations', 'sync_seq']));

    const source = new PGlite(sourceDir);
    try {
      await source.exec(`
        CREATE TABLE users (id text PRIMARY KEY, email text, version_seq bigint, created_at bigint, updated_at bigint);
        CREATE TABLE accounts (id text PRIMARY KEY, ledger_id text, name text, initial_balance numeric(18,4), initial_date bigint, created_at bigint, updated_at bigint);
        CREATE TABLE audit_logs (id text PRIMARY KEY, action text, summary jsonb, created_at bigint);
        CREATE TABLE sync_seq (id text PRIMARY KEY, seq bigint);
        INSERT INTO users VALUES ('user-1', 'migration@example.test', 23, 1000, 1000);
        INSERT INTO accounts VALUES ('account-1', 'ledger-1', '现金', 12.3400, 1000, 1000, 1000);
        INSERT INTO audit_logs VALUES ('audit-1', 'migration', '{"nested":{"ok":true}}', 1000);
        INSERT INTO sync_seq VALUES ('global', 41);
      `);
    } finally {
      await source.close();
    }

    const run = (args: string[]) => execFileAsync('node', ['scripts/migrate-pglite-to-mysql.mjs', `--source=${sourceDir}`, ...args], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: targetUrl.toString() },
    });
    const dryRun = await run([]);
    expect(dryRun.stdout).toContain('"mode": "dry-run"');
    expect(dryRun.stdout).toContain('"accounts": 1');
    expect((await target.query('SELECT COUNT(*) AS n FROM accounts'))[0]).toEqual([{ n: 0 }]);

    const executed = await run(['--execute']);
    expect(executed.stdout).toContain('迁移完成并提交');
    const [users] = await target.query<mysql.RowDataPacket[]>('SELECT email, version_seq FROM users');
    expect(users).toMatchObject([{ email: 'migration@example.test', version_seq: 23 }]);
    const [accounts] = await target.query<mysql.RowDataPacket[]>('SELECT initial_balance FROM accounts');
    expect(accounts).toMatchObject([{ initial_balance: '12.3400' }]);
    const [logs] = await target.query<mysql.RowDataPacket[]>('SELECT summary FROM audit_logs');
    expect(logs[0].summary).toEqual({ nested: { ok: true } });
    const [seq] = await target.query<mysql.RowDataPacket[]>("SELECT seq FROM sync_seq WHERE id = 'global'");
    expect(Number(seq[0].seq)).toBe(42);

    await expect(run(['--execute'])).rejects.toThrow('目标库 users 非空');
  } finally {
    await target?.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
    await rm(workDir, { recursive: true, force: true });
  }
}, 60_000);
