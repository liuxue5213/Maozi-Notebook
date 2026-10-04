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

  /** 通用对话(非流式;流式后续按需加) */
  async chat(userContent: string, system = '你是记账应用「帽子记账本」的财务分析助手,用简体中文简洁回答。'): Promise<string> {
    if (!this.key) throw new Error('AI_API_KEY 未配置');
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
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
    });
    if (!res.ok) throw new Error(`AI 上游错误 ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
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
      `- 最近流水: ${input.recentTxs.slice(0, 15).map((t) => `${t.date} ${t.note} ${t.amount}元`).join(';') || '无'}`,
      input.question ? `- 用户问题: ${input.question}` : '- 请指出消费结构特点、异常/可优化项,以及下月建议',
    ].filter(Boolean);
    return this.chat(lines.join('\n'));
  }
}
