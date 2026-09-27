import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { env } from './env';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // 上线前全检 #17:请求体上限显式化(避免默认 100KB 溢出报 500 无日志),超限走 413 语义
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  app.enableCors({ origin: true });
  await app.listen(env.PORT);
  const dbMode = env.DATABASE_URL.split('://')[0];
  console.log(`[ledgerone] http://localhost:${env.PORT} db=${dbMode}${env.DEV_MODE ? ' dev=on' : ''}`);
}

void main();
