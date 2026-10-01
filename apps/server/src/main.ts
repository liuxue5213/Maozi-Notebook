import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { env } from './env';
import { purgeRecycleBin, purgeAuditLogs } from './purge';
import { runMigrations, closeDb } from './db/db';
import { ensureGlobalSeq } from './db/bootstrap';

/** CORS 白名单:生产必须由 CORS_ORIGIN 显式配置(逗号分隔),开发态放行本地前端 */
function corsOrigin(): string[] | boolean {
  const list = env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  // 生产漏配不再反射任意 Origin(F-09),直接拒绝跨域
  return env.IS_PROD ? false : true;
}

async function main(): Promise<void> {
  // 启动即迁移(幂等):dev/存量库漏跑迁移会让新列缺失、fire-and-forget 写入静默失败
  try {
    await runMigrations();
    // P0-4:全局同步序号初始化(幂等)。初值取现有最大 server_version + 1,
    // 保证从「按用户分配」迁移到「全局单序号」后,新写入的行号严格大于任何已同步游标。
    const seq = await ensureGlobalSeq();
    console.log(`[ledgerone] 全局同步序号已就绪: ${seq}`);
  } catch (e) {
    console.error('[ledgerone] 迁移/序号初始化失败,拒绝启动:', e);
    process.exit(1);
  }
  const app = await NestFactory.create(AppModule);
  app.use(helmet()); // F-10:CSP/HSTS/X-Frame-Options 等安全头
  // 隐藏框架指纹(x-powered-by 是 express 实例方法,Nest 抽象层未暴露)
  (app.getHttpAdapter().getInstance() as { disable?: (k: string) => void }).disable?.('x-powered-by');
  // 上线前全检 #17:请求体上限显式化(避免默认 100KB 溢出报 500 无日志),超限走 413 语义
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  app.enableCors({ origin: corsOrigin() });
  await app.listen(env.PORT);
  const dbMode = env.DATABASE_URL.split('://')[0];
  console.log(`[ledgerone] http://localhost:${env.PORT} db=${dbMode}${env.DEV_MODE ? ' dev=on' : ''}`);
  // 回收站 30 天清理(PRD M01-F12 / 全检 #13)+ 审计日志 90 天保留(第 6 轮审查):
  // 启动即跑一次,之后每 6 小时一次
  const runMaintenance = async (): Promise<void> => {
    try {
      const recycled = await purgeRecycleBin();
      const audited = await purgeAuditLogs();
      console.log(`[ledgerone] 维护完成:回收站清理 ${recycled} 条,审计日志过期清理 ${audited} 条`);
    } catch (e) {
      console.error('[ledgerone] 定时维护失败:', e);
    }
  };
  void runMaintenance();
  setInterval(() => void runMaintenance(), 6 * 60 * 60 * 1000).unref();

  // 优雅停机(第 5 轮运维发现:PGlite 被 SIGKILL 后库文件无法再打开):SIGTERM/SIGINT 收尾落盘
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[ledgerone] 收到 ${signal},优雅停机…`);
    try {
      await app.close();
      await closeDb();
    } catch (e) {
      console.error('[ledgerone] 停机清理异常:', e);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // P1-35(Review 2D):进程级兜底 —— 未捕获异常/拒绝留痕但不崩(灰度期不能盲飞);
  // 审计/异步清理等 fire-and-forget 路径的失败都会落到这里被看见
  process.on('unhandledRejection', (reason) => {
    console.error('[ledgerone] unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[ledgerone] uncaughtException:', err);
  });
}

void main();
