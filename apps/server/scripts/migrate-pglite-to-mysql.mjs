import 'dotenv/config';
import { PGlite } from '@electric-sql/pglite';
import mysql from 'mysql2/promise';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Stop all writers and use a filesystem backup of the old PGlite directory as --source.
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const sourcePath = option('--source');
const targetUrl = option('--target') ?? process.env.DATABASE_URL;
const execute = args.includes('--execute');
if (!sourcePath || !targetUrl || !targetUrl.startsWith('mysql://') || !existsSync(sourcePath)) {
  throw new Error('用法: node scripts/migrate-pglite-to-mysql.mjs --source=/path/to/backup --target=mysql://... [--execute]');
}

const tables = [
  'users', 'ledgers', 'ledger_members', 'accounts', 'categories', 'tags', 'transactions',
  'transaction_tags', 'budgets', 'budget_items', 'recurring_rules', 'attachments',
  'pending_transactions', 'debts', 'reimbursements', 'savings_plans', 'sync_changes',
  'audit_logs', 'refresh_tokens', 'phone_codes', 'login_locks',
];
const quote = (name) => `\`${name.replaceAll('`', '``')}\``;
const scaledAmount = (value) => {
  const sign = String(value).startsWith('-') ? -1n : 1n;
  const [whole, fraction = ''] = String(value).replace(/^-/, '').split('.');
  if (fraction.length > 4) throw new Error(`金额精度超过 4 位: ${value}`);
  return sign * (BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0')));
};
const source = new PGlite(resolve(sourcePath));
const target = await mysql.createConnection(targetUrl);

try {
  const [targetTables] = await target.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  const targetNames = new Set(targetTables.map((row) => row.table_name));
  if (!targetNames.has('__drizzle_migrations') || !targetNames.has('sync_seq')) {
    throw new Error(`目标库尚未运行 MySQL 迁移;请先在空库启动服务端一次(实际找到 ${targetNames.size} 张表: ${[...targetNames].sort().join(', ') || '无'})`);
  }
  const sourceTables = new Set((await source.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  )).rows.map((row) => row.tablename));
  const plans = [];
  for (const table of tables) {
    if (!targetNames.has(table)) throw new Error(`目标库缺少表 ${table}`);
    const [existing] = await target.query(`SELECT COUNT(*) AS n FROM ${quote(table)}`);
    if (Number(existing[0].n) !== 0) throw new Error(`目标库 ${table} 非空;只允许导入空业务库`);
    if (!sourceTables.has(table)) {
      plans.push({ table, columns: [], jsonColumns: new Set(), count: 0 });
      continue;
    }
    const sourceColumns = (await source.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', table],
    )).rows.map((row) => row.column_name);
    const [targetColumns] = await target.query(
      'SELECT column_name, data_type, extra FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
      [table],
    );
    const writable = targetColumns.filter((col) => !String(col.extra).includes('GENERATED'));
    const targetSet = new Set(writable.map((col) => col.column_name));
    const missing = sourceColumns.filter((col) => !targetSet.has(col));
    if (missing.length) throw new Error(`源表 ${table} 有目标库无法保存的字段: ${missing.join(', ')}`);
    const columns = writable.map((col) => col.column_name).filter((col) => sourceColumns.includes(col));
    const jsonColumns = new Set(writable.filter((col) => col.data_type === 'json').map((col) => col.column_name));
    const count = Number((await source.query(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);
    plans.push({ table, columns, jsonColumns, count });
  }
  const sourceSeq = sourceTables.has('sync_seq')
    ? Number((await source.query("SELECT seq FROM sync_seq WHERE id = 'global'")).rows[0]?.seq ?? 0)
    : 0;
  const legacyUserSeq = sourceTables.has('users')
    ? Number((await source.query('SELECT COALESCE(MAX(version_seq), 0) AS seq FROM users')).rows[0]?.seq ?? 0)
    : 0;
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', rows: Object.fromEntries(plans.map(({ table, count }) => [table, count])), sourceSeq }, null, 2));
  if (!execute) {
    console.log('预检完成。确认源目录是停写后的备份，且目标库为空，再加 --execute 执行。');
  } else {
    await target.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES'");
    await target.beginTransaction();
    try {
      let maxVersion = Math.max(sourceSeq, legacyUserSeq);
      for (const { table, columns, jsonColumns, count } of plans) {
        if (!count) continue;
        const names = columns.map(quote).join(', ');
        // LIMIT/OFFSET 在稳定的离线备份上分块读取,避免整个库一次驻留内存。
        for (let offset = 0; offset < count; offset += 100) {
          const rows = (await source.query(
            `SELECT ${columns.map((col) => `"${col}"`).join(', ')} FROM "${table}" ORDER BY ${columns.includes('id') ? '"id"' : 'ctid'} LIMIT 100 OFFSET ${offset}`,
          )).rows;
          const placeholders = rows.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
          const values = rows.flatMap((row) => columns.map((col) => {
            const value = row[col];
            if (col === 'server_version' && value != null) maxVersion = Math.max(maxVersion, Number(value));
            if (value == null) return null;
            return jsonColumns.has(col) ? JSON.stringify(value) : value;
          }));
          await target.execute(`INSERT INTO ${quote(table)} (${names}) VALUES ${placeholders}`, values);
        }
        const [actual] = await target.query(`SELECT COUNT(*) AS n FROM ${quote(table)}`);
        if (Number(actual[0].n) !== count) throw new Error(`${table} 数量校验失败: ${count} -> ${actual[0].n}`);
        for (const amount of ['amount', 'amount_base', 'initial_balance', 'total_amount', 'goal_amount', 'principal', 'repaid']) {
          if (!columns.includes(amount)) continue;
          const src = (await source.query(`SELECT COALESCE(SUM("${amount}"), 0)::text AS total FROM "${table}"`)).rows[0].total;
          const [dst] = await target.query(`SELECT CAST(COALESCE(SUM(${quote(amount)}), 0) AS CHAR) AS total FROM ${quote(table)}`);
          if (scaledAmount(src) !== scaledAmount(dst[0].total)) throw new Error(`${table}.${amount} 金额合计校验失败`);
        }
      }
      await target.execute(
        'INSERT INTO sync_seq (id, seq) VALUES (?, ?) ON DUPLICATE KEY UPDATE seq = GREATEST(seq, VALUES(seq))',
        ['global', maxVersion + 1],
      );
      await target.commit();
      console.log(`迁移完成并提交;同步序号下界 ${maxVersion + 1}。请进行客户端完整拉取与上行演练。`);
    } catch (error) {
      await target.rollback();
      throw error;
    }
  }
} finally {
  await target.end();
  await source.close();
}
