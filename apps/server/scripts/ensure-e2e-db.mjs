import mysql from 'mysql2/promise';

const target = new URL(process.env.E2E_DATABASE_URL ?? 'mysql://root:local-root-only@127.0.0.1:3306/ledgerone_e2e');
const name = decodeURIComponent(target.pathname.slice(1));
if (!/^ledgerone_e2e(?:_[a-zA-Z0-9_]+)?$/.test(name)) {
  throw new Error('E2E_DATABASE_URL 必须指向独立的 ledgerone_e2e 数据库');
}
target.pathname = '/mysql';
const connection = await mysql.createConnection(target.toString());
try {
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
} finally {
  await connection.end();
}
