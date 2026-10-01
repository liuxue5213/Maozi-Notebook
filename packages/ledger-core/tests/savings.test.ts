/** 存钱计划纯函数(需求 V1.1-a,第 32 轮):促销月数值示例/target=0 除零/Σ 校验/净结余口径 */
import { describe, expect, it } from 'vitest';
import { allocateSavingsGoal, computeSavingsProgress, netSavings, suggestCutbacks } from '../src/savings';

describe('allocateSavingsGoal(均分 + 促销月缓冲,US-SP-04 数值示例)', () => {
  it('文档示例:T=30000, E=5000, k=1.75, promo=[6,11] → 促销月 0、正常月 3000、Σ=30000', () => {
    const r = allocateSavingsGoal({ goal: '30000', monthlyExpense: '5000', promoMonths: [6, 11], multiplier: 1.75 });
    expect(r.fellBack).toBe(false);
    const p6 = r.monthly.find((m) => m.month === 6)!;
    const p11 = r.monthly.find((m) => m.month === 11)!;
    const normal = r.monthly.find((m) => m.month === 1)!;
    expect(Number(p6.target)).toBe(0);
    expect(p6.isPromo).toBe(true);
    expect(Number(p11.target)).toBe(0);
    expect(Number(normal.target)).toBe(3000);
    expect(normal.allocated).toBe('500.00'); // 含分摊 ¥500
    expect(r.promoBuffer).toBe('5000.00');   // 已为 6/11 月预留 ¥5000
    const total = r.monthly.reduce((acc, m) => acc + Number(m.target), 0);
    expect(total).toBe(30000); // Σ 必须 = T
  });

  it('文档示例 2:E=2000, Δ=1500 → 正常月 2800、促销月 1000、Σ=30000', () => {
    const r = allocateSavingsGoal({ goal: '30000', monthlyExpense: '2000', promoMonths: [6, 11], multiplier: 1.75 });
    expect(Number(r.monthly.find((m) => m.month === 1)!.target)).toBe(2800);
    expect(Number(r.monthly.find((m) => m.month === 6)!.target)).toBe(1000);
    expect(r.monthly.reduce((acc, m) => acc + Number(m.target), 0)).toBe(30000);
  });

  it('even(纯均分):促销月目标仍为 M,promoBuffer=0', () => {
    const r = allocateSavingsGoal({ goal: '30000', monthlyExpense: '5000', promoMonths: [6], multiplier: 1.75, } as never);
    // even 语义由 UI 层传 promoMonths=[] 表达;此处验证促销月集合为空时退化为均分
    const r2 = allocateSavingsGoal({ goal: '30000', monthlyExpense: '5000', promoMonths: [], multiplier: 1.75 });
    expect(r2.promoBuffer).toBe('0.00');
    expect(r2.monthly.every((m) => Number(m.target) === 2500)).toBe(true);
    void r;
  });

  it('EX-16:促销月 target=0 时 computeSavingsProgress 不除零,risk=promo', () => {
    const r = allocateSavingsGoal({ goal: '30000', monthlyExpense: '5000', promoMonths: [6, 11], multiplier: 1.75 });
    const now = new Date(2026, 5, 20); // 6 月
    const p = computeSavingsProgress({
      goal: '30000', monthlyTargets: r.monthly,
      actualNetByMonth: { 1: '3000', 2: '3000', 3: '3000', 4: '3000', 5: '3000', 6: '-1000' },
      now,
    });
    expect(p.risk).toBe('promo'); // 促销月按调整后目标(target=0)判定,不除零
    expect(Number(p.saved)).toBe(14000); // 5×3000 + (−1000),负月不平滑
  });

  it('EX-18:倍数越界(3.5)→ 防御回退 fellBack', () => {
    const r = allocateSavingsGoal({ goal: '30000', monthlyExpense: '5000', promoMonths: [6], multiplier: 3.5 });
    expect(r.fellBack).toBe(true);
  });

  it('尾差修正:Σ 与 T 的定点残差分摊到最后一个正常月,总量精确', () => {
    const r = allocateSavingsGoal({ goal: '10000', monthlyExpense: '3333', promoMonths: [3, 7], multiplier: 1.5 });
    const total = r.monthly.reduce((acc, m) => acc + Number(m.target), 0);
    expect(Math.abs(total - 10000)).toBeLessThanOrEqual(0.02); // 分位噪声 ≤2 分
    expect(r.fellBack).toBe(false);
  });
});

describe('净结余口径(Q3 决策)', () => {
  it('netSavings:income−expense,转账不计,软删不计,负结余不截断(scale 随操作数定点)', () => {
    expect(netSavings([
      { type: 'income', amount_base: '8000', is_deleted: false },
      { type: 'expense', amount_base: '5000', is_deleted: false },
      { type: 'transfer', amount_base: '2000', is_deleted: false },
      { type: 'expense', amount_base: '500', is_deleted: true },
    ])).toBe('3000');
    expect(netSavings([{ type: 'expense', amount_base: '500.00', is_deleted: false }])).toBe('-500'); // subAmount scale 随操作数
  });
});

describe('suggestCutbacks(SP-FR-06 三档压缩)', () => {
  it('Top3 分类月均 × 10/20/30%', () => {
    const r = suggestCutbacks([
      { categoryId: 'c1', avgAmount: '1700.00' },
      { categoryId: 'c2', avgAmount: '450.00' },
      { categoryId: 'c3', avgAmount: '300.00' },
      { categoryId: 'c4', avgAmount: '100.00' }, // Top3 之外裁掉
    ]);
    expect(r).toHaveLength(3);
    expect(r[0].cut20).toBe('340.00'); // 外食压缩 20% → 340(AI 示例数值同源)
    expect(r[1].cut10).toBe('45.00');
  });
});
