import { Injectable } from '@nestjs/common';
import { env } from '../env';

/**
 * 阿里云百炼(OpenAI 兼容模式)客户端:qwen-plus。
 * 密钥/地址走服务端 .env(AI_API_KEY / AI_BASE_URL / AI_MODEL),绝不进客户端。
 */
@Injectable()
export class AiService {
  private baseUrl = process.env.AI_BASE_URL ?? 'https://llm-jufv4y6r83r9f3n9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  private model = process.env.AI_MODEL ?? 'qwen-plus';

  private get key(): string {
    return process.env.AI_API_KEY ?? '';
  }

  /** 通用对话(非流式;流式后续按需加)。8s 超时(P-4):上游卡死时快速失败,由端上走降级文案 */
  async chat(userContent: string, system = '你是记账应用「帽子记账本」的财务分析助手,用简体中文简洁回答。'): Promise<string> {
    if (!this.key) throw new Error('AI_API_KEY 未配置');
    let res: Response;
    // P-4 超时:AbortSignal.timeout 需 Node 17.3+(树莓派 Node 版本低会 TypeError→500),
    // 改用 AbortController + setTimeout 手动实现(Node 15+ 即可)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
          stream: false,
        }),
        signal: ctrl.signal,
      });
    } catch {
      throw new Error('AI 服务超时或不可达,请稍后重试');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`AI 上游错误 ${res.status}`);
    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      // 审查修复:200 但响应体损坏(截断/非 JSON)时给明确文案,不让裸 SyntaxError 变 500
      throw new Error('AI 上游返回了无法解析的响应,请稍后重试');
    }
    return data.choices?.[0]?.message?.content ?? '';
  }

  /** 消费分析:把月度汇总 + 分类排行 + 最近流水摘要喂给模型产出洞察 */
  async analyzeSpending(input: {
    month: string;
    income: string;
    expense: string;
    budget?: string | null;
    topCategories: Array<{ name: string; amount: string }>;
    recentTxs: Array<{ note: string; amount: string; date: string }>;
    question?: string;
  }): Promise<string> {
    const lines = [
      `分析 ${input.month} 的记账数据并给出简短洞察(3-6 条要点):`,
      `- 本月收入 ${input.income} 元,支出 ${input.expense} 元`,
      input.budget ? `- 月预算 ${input.budget} 元` : '',
      `- 支出分类排行: ${input.topCategories.map((c) => `${c.name} ${c.amount}元`).join('、') || '无'}`,
      // P-1 数据最小化:备注仅保留前 8 字再出域,减少个人信息上传第三方模型
      `- 最近流水: ${input.recentTxs.slice(0, 15).map((t) => `${t.date} ${t.note.slice(0, 8)} ${t.amount}元`).join(';') || '无'}`,
      input.question ? `- 用户问题: ${input.question}` : '- 请指出消费结构特点、异常/可优化项,以及下月建议',
    ].filter(Boolean);
    return this.chat(lines.join('\n'));
  }
  /** 智能记账解析:自然语言 → 结构化记账信息(金额/类型/分类/备注/日) */
  async parseExpense(text: string, categoryNames: string[]): Promise<{ amount: number; type: 'expense' | 'income'; category: string | null; note: string; day: number | null }> {
    const system = [
      '你是记账解析器。从文本中提取一条记账信息,只输出 JSON(无其它文字):',
      '{"amount": number, "type": "expense"|"income", "category": string|null, "note": string, "day": number|null}',
      `分类必须从以下列表中选(找不到合适就 null): ${categoryNames.join('、')}`,
      'day 是本月几号(未提及则 null)。示例:「昨天打车25块」→ {"amount":25,"type":"expense","category":"交通","note":"打车","day":null}',
    ].join('\n');
    const raw = await this.chat(text, system);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI 未返回有效 JSON');
    const j = JSON.parse(m[0]) as { amount?: number; type?: string; category?: string | null; note?: string; day?: number | null };
    if (typeof j.amount !== 'number' || j.amount <= 0) throw new Error('未能解析出金额');
    return {
      amount: j.amount,
      type: j.type === 'income' ? 'income' : 'expense',
      category: typeof j.category === 'string' ? j.category : null,
      note: typeof j.note === 'string' ? j.note : text,
      day: typeof j.day === 'number' ? j.day : null,
    };
  }
}
