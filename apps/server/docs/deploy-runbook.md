# LedgerOne 部署与备份恢复 Runbook(上线前全检 B7)

> 适用:apps/server(NestJS + Drizzle + PostgreSQL)。开发态默认 PGlite,生产一律标准 PostgreSQL。

## 1. 数据库 Schema 迁移(版本化)

- 迁移 SQL 位于 `apps/server/drizzle/*.sql`(已纳入版本控制,**勿再 gitignore**)。
- 修改 `src/db/schema.ts` 后:

```bash
cd apps/server
npx drizzle-kit generate   # 产出增量 SQL(含 down 语义由 meta 记录)
```

- 应用迁移(生产):按序执行 `drizzle/*.sql`(PSQL 或 `drizzle-kit migrate`)。**不要**在生产用 `drizzle-kit push`(无版本记录,全检 B7 判定为不可回滚风险)。
- 迁移必须向前兼容:旧客户端可继续读写(见 PRD 10.3)。

## 2. PGlite → PostgreSQL 迁移路径(⚠️ 重要)

- `apps/server/data/` 是 PGlite 的 WASM 数据目录,**不能直接拷给标准 PG 使用**;
- PGlite 单进程独占锁,多副本挂同一目录会**数据损坏**;
- 正确路径:生产新建标准 PG 库 → 执行迁移 SQL → **数据经应用层同步链路重灌**(旧设备登录后全量上行/导出 CSV 导入)。

## 3. 备份

```bash
# 每日全量(示例 cron:30 2 * * *)
pg_dump --format=custom --file=/backup/ledgerone-$(date +%F).dump \
  postgres://ledgerone:$PASSWORD@localhost:5432/ledgerone
# 保留 14 天,异地/对象存储再存一份
```

## 4. 恢复演练(每季度至少一次)

```bash
createdb ledgerone_restore
pg_restore --dbname=ledgerone_restore /backup/ledgerone-YYYY-MM-DD.dump
```

恢复后**必须验证**:

1. `users.version_seq` 最大值 ≥ 恢复前(备份点之后若有写入,需手工调高该值,保证**单调不回退**——否则客户端游标倒退漏拉数据);
2. 任取一账本,`transactions` 计数与业务侧一致;
3. 客户端以存量账号登录,增量 pull 无缺失。

## 5. 环境变量(生产)

| 变量 | 要求 |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | 标准 PG 连接串(建议 TLS) |
| `JWT_SECRET` | 必填、≥32 位、≠默认值(缺失/不合规**拒绝启动**) |
| `DEV_MODE` | **必须不设或 false**(验证码直通,生产禁止) |
