# LedgerOne MySQL 部署与数据迁移

## 新环境启动

服务端使用 MySQL 8.4、`mysql2` 和 Drizzle。Web 的 IndexedDB 与 App 的 SQLite 继续承担离线存储。开发环境可在仓库根目录运行 `docker compose up -d`，服务端默认连接 `mysql://ledgerone:ledgerone@127.0.0.1:3306/ledgerone`。

生产环境需设置 `NODE_ENV=production`、`DATABASE_URL=mysql://...`、不少于 32 字符的 `JWT_SECRET` 和 `CORS_ORIGIN`。生产环境禁止 `DEV_MODE=true`。数据库账号需要对应用库执行迁移及读写的权限。建议使用 TLS 连接和独立凭据。

首次启动会自动运行 `drizzle-mysql/` 下的版本化迁移，然后初始化全局同步序号。修改 `src/db/schema.ts` 后运行 `pnpm db:generate` 生成新迁移。生产库不要使用 `db:push`。已有表但缺少 Drizzle 迁移记录时，服务端会拒绝启动，避免把旧库误判为空库。

## 从 PostgreSQL / PGlite 迁移已有数据

旧 `drizzle/` 迁移与 `apps/server/data/` 目录属于 PostgreSQL/PGlite，不能在 MySQL 上执行或直接复制。迁移需要停写、备份源库，在空 MySQL 库执行新迁移，然后按依赖顺序转换并导入所有业务表、用户、refresh token、审计与同步日志。特别核对 `decimal(18,4)` 金额、毫秒时间戳、JSON 字段、布尔值和软删除记录。导入后把 `sync_seq.seq` 设置为不低于所有行的最大 `server_version` 与所有现存客户端游标；若无法取得客户端游标，应让客户端重置游标并完整拉取。

本仓提供 PGlite 数据搬迁脚本。停写并完整备份旧 `apps/server/data/ledgerone` 目录，先在**空 MySQL 库**运行新迁移，保持新服务停写，然后在 `apps/server/` 下执行：

```sh
pnpm db:migrate:pglite --source=/path/to/pglite-backup --target=mysql://user:password@host:3306/ledgerone
pnpm db:migrate:pglite --source=/path/to/pglite-backup --target=mysql://user:password@host:3306/ledgerone --execute
```

第一条只预检目标库并查询源数据；第二条在一个 MySQL 事务内导入，逐表核对行数及金额合计，拒绝非空业务库，并把同步序号提高至源库序号与所有行版本的上界。PGlite 打开目录时可能更新运行时文件，必须使用备份副本作为 `--source`。完成后用已登录客户端演练完整拉取、上行和登录；确认数据无误前保留原始备份。若旧服务使用独立 PostgreSQL 服务器，应先导出为 PGlite 可读备份或另写 PostgreSQL 读取适配器，本脚本只读取 PGlite 目录。

## 备份与恢复

使用 `mysqldump --single-transaction --routines --triggers ledgerone > ledgerone.sql` 创建一致性备份。恢复后核对用户数、账本数、流水笔数及金额总和，并确认 `sync_seq.seq` 大于等于所有同步实体的 `server_version`。用已登录客户端验证一次增量拉取与上行重试。

## 测试

`TEST_MYSQL_URL` 指向有 `CREATE DATABASE` 权限的 MySQL 连接串，例如本地 Docker 的 `mysql://root:local-root-only@127.0.0.1:3306/mysql`。服务端集成测试会创建唯一临时库、运行完整迁移、重复迁移以验证幂等性，结束时删除临时库。浏览器 E2E 使用 `E2E_DATABASE_URL`，默认独立的 `ledgerone_e2e` 库。
