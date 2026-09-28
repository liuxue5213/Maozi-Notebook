import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { db } from './db/db';
import { AuthModule } from './auth/auth.module';
import { LedgerModule } from './ledgers/ledger.module';
import { SyncModule } from './sync/sync.module';
import { AllExceptionsFilter } from './common/errors';

@Controller()
// 探针豁免限流(第 10 轮核验):健康检查高频轮询不得消耗/挤占用户配额,更不能 429 误导摘流
@SkipThrottle()
export class HealthController {
  @Get('healthz')
  health() {
    return { ok: true, ts: Date.now() };
  }

  /** 就绪探针:真实探活 DB(上线全检 #18,灰度摘除依据) */
  @Get('readyz')
  async ready() {
    try {
      await db.execute(sql`select 1`);
      return { ok: true, db: true };
    } catch {
      return { ok: false, db: false };
    }
  }
}

@Module({
  // F-07:全局兜底 100 次/分钟/IP;敏感路由在各自 Controller 上有更严格的 @Throttle
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    AuthModule, SyncModule, LedgerModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
