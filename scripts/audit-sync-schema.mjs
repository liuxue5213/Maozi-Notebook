/**
 * 同步协议一致性审计(2026-10-09 实战教训:transactionSchema 曾剥离 is_deleted 导致恢复操作无法跨端同步)。
 * 逐一比对:① domain 各实体 schema 声明的字段 ② 服务端 drizzle 表列 ③ sqlite-sync 入库列,
 * 输出三类差异:仅 schema 有(客户端字段会被服务端剥离→静默丢数据)、仅服务端有(schema 缺→上行即丢)、
 * sqlite-sync 缺(本地写入即丢)。
 *
 * 运行:node scripts/audit-sync-schema.mjs(在仓库根;退出码非 0 表示存在差异,可挂 CI)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// ---------- 1) 解析 domain schemas.ts 中每个实体的顶层字段 ----------
const schemaSrc = readFileSync(join(ROOT, 'packages/domain/src/schemas.ts'), 'utf8');
const schemas = {};
const schemaRe = /export const (\w+Schema) = z\.object\(\{([\s\S]*?)\n\}\);/g;
for (const m of schemaSrc.matchAll(schemaRe)) {
  const name = m[1].replace('Schema', '');
  const fields = new Set();
  for (const line of m[2].split('\n')) {
    const f = line.match(/^\s{2}(\w+):/);
    if (f) fields.add(f[1]);
  }
  schemas[name] = fields;
}

// ---------- 2) 解析服务端 schema.ts 的表列(括号计数切分,兼容索引回调尾) ----------
const serverSrc = readFileSync(join(ROOT, 'apps/server/src/db/schema.ts'), 'utf8');
const ssDir = join(ROOT, 'packages/sqlite-sync/src');
const serverTables = {};
{
  const declRe = /export const (\w+) = mysqlTable\(\s*['"]\w+['"],\s*\{/g;
  const matches = [...serverSrc.matchAll(declRe)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1];
    let depth = 1;
    let j = matches[i].index + matches[i][0].length;
    while (depth > 0 && j < serverSrc.length) {
      const ch = serverSrc[j];
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
      j++;
    }
    const body = serverSrc.slice(matches[i].index + matches[i][0].length, j - 1);
    const fields = new Set();
    for (const line of body.split('\n')) {
      const f = line.match(/^\s+(\w+):/);
      if (f) fields.add(f[1]);
    }
    serverTables[name] = fields;
  }
}

// ---------- 3) 解析 sqlite-sync tables.ts 的入库列(单行 def([...]) 形态) ----------
const ssSrc = readFileSync(join(ssDir, 'tables.ts'), 'utf8');
const sqliteCols = {};
{
  const rowRe = /(\w+): \{ table: '\w+', cols: def\(\[([\s\S]*?)\]\),?(?: jsonCols: \[[^\]]*\])?\s*\}/g;
  for (const m of ssSrc.matchAll(rowRe)) {
    const fields = new Set();
    for (const c of m[2].matchAll(/\['(\w+)',/g)) fields.add(c[1]);
    if (fields.size) sqliteCols[m[1]] = fields;
  }
}

// ---------- 4) 实体映射并比对 ----------
// domain schema 名 ↔ 服务端表名 ↔ sqlite-sync 键名
const MAP = [
  ['transaction', 'transactions', 'transaction'],
  ['budget', 'budgets', 'budget'],
  ['budgetItem', 'budget_items', 'budget_item'],
  ['category', 'categories', 'category'],
  ['account', 'accounts', 'account'],
  ['ledger', 'ledgers', 'ledger'],
  ['ledgerMember', 'ledger_members', 'ledger_member'],
  ['savingsPlan', 'savings_plans', 'savings_plan'],
  ['recurringRule', 'recurring_rules', 'recurring_rule'],
  ['pendingTransaction', 'pending_transactions', 'pending_transaction'],
  ['tag', 'tags', 'tag'],
  ['debt', 'debts', 'debt'],
  ['reimbursement', 'reimbursements', 'reimbursement'],
  ['attachment', 'attachments', 'attachment'],
];

let diffs = 0;
const out = [];
for (const [schema, table, ssKey] of MAP) {
  const sc = schemas[schema] ?? new Set();
  const sv = serverTables[table] ?? new Set();
  const sq = sqliteCols[ssKey] ?? new Set();
  // 同步元字段:domain 可选透传,服务端必有;不计差异
  const meta = new Set(['user_id', 'client_version', 'server_version', 'is_deleted', 'deleted_at', 'created_at', 'updated_at']);
  const onlySchema = [...sc].filter((f) => !sv.has(f) && !meta.has(f));
  const onlyServer = [...sv].filter((f) => !sc.has(f) && !meta.has(f) && f !== 'active_key' && f !== 'owner_user_id' && !(schema === 'account' && f === 'balance_cached')); // balance_cached=服务端计算缓存,客户端不上行属预期
  const missingSqlite = [...sv].filter((f) => !meta.has(f) && !sq.has(f) && sc.has(f)); // schema 有、服务端有、本地缺 → 本地写入即丢
  if (onlySchema.length || onlyServer.length || missingSqlite.length) {
    diffs++;
    out.push(`✗ ${schema}/${table}:`);
    if (onlySchema.length) out.push(`   仅 schema 有(上行会被服务端剥离): ${onlySchema.join(', ')}`);
    if (onlyServer.length) out.push(`   仅服务端有(schema 缺,上行即丢): ${onlyServer.join(', ')}`);
    if (missingSqlite.length) out.push(`   sqlite-sync 缺列(本地写入即丢): ${missingSqlite.join(', ')}`);
  }
}
if (diffs) {
  console.log(out.join('\n'));
  console.log(`\n共 ${diffs} 个实体存在协议差异——逐项修复后再纳入同步范围`);
  process.exit(1);
} else {
  console.log('✓ 同步协议一致性审计通过:14 个实体 schema/服务端表/sqlite-sync 三方对齐');
}
