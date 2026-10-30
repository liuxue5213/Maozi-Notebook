import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AiService } from './ai.service';
import { JwtGuard } from '../common/guard';
import type { AuthedRequest } from '../common/guard';
import { AppError } from '../common/errors';

const insightSchema = z.object({
  month: z.string().min(1),
  income: z.string(),
  expense: z.string(),
  budget: z.string().nullable().optional(),
  topCategories: z.array(z.object({ name: z.string(), amount: z.string() })).max(15),
  recentTxs: z.array(z.object({ note: z.string(), amount: z.string(), date: z.string() })).max(30),
  question: z.string().max(500).optional(),
});

/** P-2:AI 用户级配额(次/日),与全局 IP 限流互补。内存计数,多实例部署需换集中存储 */
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT ?? 30);
const quota = new Map<string, { day: string; used: number }>();

/** 按「服务器本地时区的自然日」取日(审查修复:原 UTC 取日导致中国用户配额要到早 8 点才重置) */
function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function consumeQuota(userId: string): void {
  const day = localDay();
  const q = quota.get(userId);
  if (!q || q.day !== day) { quota.set(userId, { day, used: 1 }); return; }
  if (q.used >= DAILY_LIMIT) {
    throw new AppError('ai.quota.429', 429, `今日 AI 使用次数已达上限(${DAILY_LIMIT} 次),明天再来吧`);
  }
  q.used += 1;
}

/** P-5:调用审计(user/场景/耗时/结果),只记元数据不记原文 */
function audit(userId: string, scene: string, startedAt: number, ok: boolean, err?: string): void {
  console.log(`[ai.audit] user=${userId} scene=${scene} ms=${Date.now() - startedAt} ok=${ok}${err ? ` err=${err}` : ''}`);
}

async function guarded(userId: string, scene: string, run: () => Promise<unknown>): Promise<unknown> {
  consumeQuota(userId);
  const startedAt = Date.now();
  try {
    const result = await run();
    audit(userId, scene, startedAt, true);
    return result;
  } catch (e) {
    audit(userId, scene, startedAt, false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

@Controller()
@UseGuards(JwtGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** 消费洞察分析(需登录;全局限流 + 用户级日配额) */
  @Post('v1/ai/insights')
  async insights(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(insightSchema)) body: unknown) {
    return { text: await guarded(req.userId, 'insights', () => this.ai.analyzeSpending(body as never)) as string };
  }

  /** 智能记账解析:自然语言 → 结构化(T-38 替代方案,无语音) */
  @Post('v1/ai/parse')
  async parse(@Req() req: AuthedRequest, @Body() body: { text?: string; categories?: string[] }) {
    const text = (body?.text ?? '').slice(0, 500);
    const categories = Array.isArray(body?.categories) ? body.categories.slice(0, 60).map(String) : [];
    if (!text.trim()) throw new Error('text 为空');
    return await guarded(req.userId, 'parse', () => this.ai.parseExpense(text, categories));
  }

  /** 通用 AI 问答(预留智能记账/语音解析) */
  @Post('v1/ai/chat')
  async chat(@Req() req: AuthedRequest, @Body() body: { content?: string }) {
    const content = (body?.content ?? '').slice(0, 2000);
    if (!content.trim()) throw new Error('content 为空');
    return { text: await guarded(req.userId, 'chat', () => this.ai.chat(content)) as string };
  }
}
