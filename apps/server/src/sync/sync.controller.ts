import { Controller, Get, Post, Body, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { pushBodySchema } from '@ledgerone/domain';
import { ZodValidationPipe } from '../common/zod.pipe';
import { JwtGuard } from '../common/guard';
import type { AuthedRequest } from '../common/guard';
import { SyncService } from './sync.service';

type PushBody = z.infer<typeof pushBodySchema>;

@Controller()
@UseGuards(JwtGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('v1/sync/push')
  push(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(pushBodySchema)) body: PushBody) {
    return this.sync.push(req.userId, body.changes);
  }

  @Get('v1/sync/pull')
  pull(
    @Req() req: AuthedRequest,
    @Query('cursor') cursor = '0',
    @Query('limit') limit = '500',
  ) {
    const c = Math.max(0, Number(cursor) || 0);
    const l = Math.min(500, Math.max(1, Number(limit) || 500));
    return this.sync.pull(req.userId, c, l);
  }
}
