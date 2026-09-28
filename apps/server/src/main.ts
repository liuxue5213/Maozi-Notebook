import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { env } from './env';
import { purgeRecycleBin } from './purge';

/** CORS 白名单:生产必须由 CORS_ORIGIN 显式配置(逗号分隔),开发态放行本地前端 */
function corsOrigin(): string[] | boolean {
  const list = (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  // 生产漏配不再反射任意 Origin(F-09),直接拒绝跨域
  return env.IS_PROD ? false : true;
}

async function main(): Promise<void> {
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
  // 回收站 30 天清理(PRD M01-F12 / 全检 #13):启动即跑一次,之后每 6 小时一次
  void purgeRecycleBin()
    .then((n) => console.log(`[ledgerone] 回收站清理完成,删除 ${n} 条过期数据`))
    .catch((e) => console.error('[ledgerone] 回收站清理失败:', e));
  setInterval(() => {
    void purgeRecycleBin().catch((e) => console.error('[ledgerone] 回收站清理失败:', e));
  }, 6 * 60 * 60 * 1000).unref();
}

void main();
