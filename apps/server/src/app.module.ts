import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { LedgerModule } from './ledgers/ledger.module';
import { SyncModule } from './sync/sync.module';
import { AllExceptionsFilter } from './common/errors';

@Controller()
export class HealthController {
  @Get('healthz')
  health() {
    return { ok: true, ts: Date.now() };
  }
}

@Module({
  imports: [AuthModule, SyncModule, LedgerModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
