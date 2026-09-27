import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { LEDGER_TYPES } from '@ledgerone/domain';
import { ZodValidationPipe } from '../common/zod.pipe';
import { JwtGuard } from '../common/guard';
import type { AuthedRequest } from '../common/guard';
import { LedgerService } from './ledger.service';

const createSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(LEDGER_TYPES).default('personal'),
});

const renameSchema = z.object({ name: z.string().min(1).max(50) });

type CreateBody = z.infer<typeof createSchema>;
type RenameBody = z.infer<typeof renameSchema>;

@Controller()
@UseGuards(JwtGuard)
export class LedgerController {
  constructor(private readonly ledgers: LedgerService) {}

  @Get('v1/ledgers')
  list(@Req() req: AuthedRequest) {
    return this.ledgers.list(req.userId);
  }

  @Post('v1/ledgers')
  create(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(createSchema)) body: CreateBody) {
    return this.ledgers.create(req.userId, body.name, body.type);
  }

  @Patch('v1/ledgers/:id')
  rename(@Req() req: AuthedRequest, @Param('id') id: string, @Body(new ZodValidationPipe(renameSchema)) body: RenameBody) {
    return this.ledgers.rename(req.userId, id, body.name);
  }

  @Delete('v1/ledgers/:id')
  remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.ledgers.remove(req.userId, id);
  }
}
