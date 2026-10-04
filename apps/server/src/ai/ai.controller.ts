import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AiService } from './ai.service';
import { JwtGuard } from '../common/guard';
import type { AuthedRequest } from '../common/guard';

const insightSchema = z.object({
  month: z.string().min(1),
  income: z.string(),
  expense: z.string(),
  budget: z.string().nullable().optional(),
  topCategories: z.array(z.object({ name: z.string(), amount: z.string() })).max(15),
  recentTxs: z.array(z.object({ note: z.string(), amount: z.string(), date: z.string() })).max(30),
  question: z.string().max(500).optional(),
});

@Controller()
@UseGuards(JwtGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** 消费洞察分析(需登录;限流由全局 ThrottlerGuard 控制) */
  @Post('v1/ai/insights')
  async insights(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(insightSchema)) body: unknown) {
    return { text: await this.ai.analyzeSpending(body as never) };
  }

  /** 通用 AI 问答(预留智能记账/语音解析) */
  @Post('v1/ai/chat')
  async chat(@Req() _req: AuthedRequest, @Body() body: { content?: string }) {
    const content = (body?.content ?? '').slice(0, 2000);
    if (!content.trim()) throw new Error('content 为空');
    return { text: await this.ai.chat(content) };
  }
}
