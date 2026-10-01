import { addAmount, subAmount } from '@ledgerone/domain';

/**
 * 存钱计划纯函数(需求 V1.1-a,第 32 轮):金额一律由本文件产出 —— AI/展示层不得生成数字。
 * 口径(Q3 决策):已存 = 期间净结余(income 流水 − expense 流水),转账不计;
 * 负结余按负值展示不截断;年度累计 = Σ 各月净结余(不做 max(0,·) 平滑)。
 */

export interface MonthBaseline {
  year: number;
  month: number;
  income: string;
  expense: string;
  /** 净结余 = income − expense(可为负) */
  net: string;
}

export interface SavingsBaseline {
  /** 参与计算的月数(全月零流水的月份已剔除) */
  months: number;
  /** 样本不足(<3 月)标记:可行性置「无法判断」(EX-08) */
  insufficient: boolean;
  avgIncome: string;
  avgExpense: string;
  avgNet: string;
  /** Top-N 分类月均(节流建议用,金额由纯函数产出) */
  topCategories: Array<{ categoryId: string | null; avgAmount: string }>;
  /** 检测到的一次性大额(EX-09:如刷漆 926.43 占当月 43%) */
  oneOffs: Array<{ id: string; amount: string; month: string; pctOfMonth: number }>;
}

export interface MonthlyTarget {
  month: number;
  target: string;
  /** true=促销月(让出额分摊出去) */
  isPromo: boolean;
  /** 正常月标注「含分摊 ¥X」;促销月标注让出额 */
  allocated: string;
}

/** 期间净结余:income − expense(转账不计 —— 与报表口径一致) */
export function netSavings(txs: Array<{ type: string; amount_base: string; is_deleted: boolean }>): string {
  let net = '0';
  for (const t of txs) {
    if (t.is_deleted || t.type === 'transfer') continue;
    if (t.type === 'income') net = addAmount(net, t.amount_base);
    else if (t.type === 'expense') net = subAmount(net, t.amount_base);
  }
  return net;
}

/** 基线分析:近 N 月月均收/支/结余 + Top-N 分类月均 + 一次性大额检测 */
export function computeSavingsBaseline(
  months: MonthBaseline[],
  txs: Array<{ id: string; type: string; amount_base: string; happened_at: number; is_deleted: boolean; category_id: string | null }>,
  topN = 3,
): SavingsBaseline {
  const active = months.filter((m) => m.income !== '0' || m.expense !== '0'); // 全月零流水剔除
  const n = active.length || 1;
  const sum = (pick: (m: MonthBaseline) => string): string => active.reduce((acc, m) => addAmount(acc, pick(m)), '0');
  const avgIncome = n ? Number(sum((m) => m.income)) / n : 0;
  const avgExpense = n ? Number(sum((m) => m.expense)) / n : 0;
  // 分类月均:仅统计支出
  const catTotals = new Map<string, number>();
  const oneOffs: SavingsBaseline['oneOffs'] = [];
  const nowD = new Date();
  for (let mi = 0; mi < active.length; mi++) {
    const m = active[mi];
    const monthKey = `${m.year}-${String(m.month).padStart(2, '0')}`;
    for (const t of txs) {
      if (t.is_deleted || t.type !== 'expense') continue;
      const d = new Date(t.happened_at);
      if (d.getFullYear() !== m.year || d.getMonth() + 1 !== m.month) continue;
      catTotals.set(t.category_id ?? '', (catTotals.get(t.category_id ?? '') ?? 0) + Number(t.amount_base));
    }
    // 一次性大额:单笔 > 当月支出 30%
    for (const t of txs) {
      if (t.is_deleted || t.type !== 'expense') continue;
      const d = new Date(t.happened_at);
      if (d.getFullYear() !== m.year || d.getMonth() + 1 !== m.month) continue;
      const pct = m.expense !== '0' ? (Number(t.amount_base) / Number(m.expense)) * 100 : 0;
      if (pct > 30) oneOffs.push({ id: t.id, amount: t.amount_base, month: monthKey, pctOfMonth: Math.round(pct) });
    }
  }
  void nowD;
  const topCategories = [...catTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([categoryId, total]) => ({ categoryId, avgAmount: (total / n).toFixed(2) }));
  return {
    months: active.length,
    insufficient: active.length < 3,
    avgIncome: avgIncome.toFixed(2),
    avgExpense: avgExpense.toFixed(2),
    avgNet: (avgIncome - avgExpense).toFixed(2),
    topCategories,
    oneOffs,
  };
}

export interface AllocateInput {
  /** 年度目标 T */
  goal: string;
  /** 月均支出 E(基线或手填) */
  monthlyExpense: string;
  /** 促销月集合(1–12) */
  promoMonths: number[];
  /** 促销倍数 k ∈ [1,3] */
  multiplier: number;
}

export interface AllocateResult {
  monthly: MonthlyTarget[];
  /** Σ 校验(±0.01 内必须等于 goal;失败回退纯均分,EX-17) */
  totalCheck: string;
  /** 回退标记(校验失败时 true) */
  fellBack: boolean;
  /** 促销让出总额(顶部提示「已为 6/11 月预留 ¥S 缓冲」) */
  promoBuffer: string;
}

/**
 * 年度目标分解(Q4 决策:均分基线 + 促销月缓冲,需求 3.6):
 *   M = T/12;Δ = E×(k−1);d = min(M, Δ);促销月 = M−d;S = p×d;正常月 = M + S/(12−p)。
 * Σ 必须 = T(±0.01),失败回退纯均分并标 fellBack(EX-17);促销月目标可为 0(EX-16 不除零)。
 */
export function allocateSavingsGoal(input: AllocateInput): AllocateResult {
  const T = Number(input.goal);
  const E = Number(input.monthlyExpense);
  const k = input.multiplier;
  if (!(T > 0) || k < 1 || k > 3) {
    return { monthly: [], totalCheck: '0', fellBack: true, promoBuffer: '0' }; // EX-18 越界拒绝由调用方处理,此处防御返回
  }
  const promoSet = new Set(input.promoMonths.filter((m) => m >= 1 && m <= 12));
  const p = promoSet.size;
  const evenFallback = (): AllocateResult => {
    const per = (T / 12).toFixed(2);
    return {
      monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, target: per, isPromo: promoSet.has(i + 1), allocated: '0.00' })),
      totalCheck: T.toFixed(2),
      fellBack: true,
      promoBuffer: '0.00',
    };
  };

  const M = T / 12;
  const delta = E * (k - 1);
  const d = Math.min(M, delta);
  const promoTarget = M - d;
  const S = p * d;
  const normalAdd = 12 - p > 0 ? S / (12 - p) : 0;
  const normalTarget = M + normalAdd;

  // 尾差修正:分摊到正常月最后一个月(定点分位噪声)
  const monthly: MonthlyTarget[] = [];
  let allocated = 0;
  const normalSlots: number[] = [];
  for (let m = 1; m <= 12; m++) {
    if (promoSet.has(m)) {
      monthly.push({ month: m, target: promoTarget.toFixed(2), isPromo: true, allocated: d.toFixed(2) });
    } else {
      normalSlots.push(m);
      monthly.push({ month: m, target: normalTarget.toFixed(2), isPromo: false, allocated: normalAdd.toFixed(2) });
      allocated += normalTarget;
    }
  }
  allocated += p * promoTarget;
  const check = Math.abs(allocated - T);
  if (check > 0.01) return evenFallback(); // EX-17:回退纯均分
  // 尾差:把 Σ 与 T 的残余差分摊到最后一个正常月
  const residual = T - allocated;
  if (Math.abs(residual) >= 0.005 && normalSlots.length) {
    const last = normalSlots[normalSlots.length - 1];
    const slot = monthly.find((m) => m.month === last)!;
    slot.target = (Number(slot.target) + residual).toFixed(2);
  }
  return {
    monthly,
    totalCheck: (allocated + residual).toFixed(2),
    fellBack: false,
    promoBuffer: (p * d).toFixed(2),
  };
}

export interface SavingsProgress {
  /** 已存 = Σ 期间各月净结余(含负值,不平滑) */
  saved: string;
  /** 达成率 %(促销月 target=0 时不除零:该月不计入分母目标) */
  ratePct: number;
  /** 按当前速度的年末预测 */
  projected: string;
  /** risk: ok | warn | behind | promo |
   *  ok=达标 warn=接近 behind=落后 promo=促销月(按调整后目标判定) */
  risk: 'ok' | 'warn' | 'behind' | 'promo';
}

/** 进度追踪(净结余口径):促销月按调整后目标判定;target=0 时达成率不除零(EX-16) */
export function computeSavingsProgress(input: {
  goal: string;
  monthlyTargets: MonthlyTarget[];
  /** 已度过月份的实际净结余(与 monthlyTargets 对齐,可为负) */
  actualNetByMonth: Record<number, string>;
  now: Date;
}): SavingsProgress {
  let saved = '0';
  let targetSum = 0;
  for (const m of input.monthlyTargets) {
    const actual = input.actualNetByMonth[m.month];
    if (actual !== undefined) saved = addAmount(saved, actual);
    targetSum += Number(m.target);
  }
  const ratePct = targetSum > 0 ? Math.round((Number(saved) / targetSum) * 100) : 0;
  const nowM = input.now.getMonth() + 1;
  const cur = input.monthlyTargets.find((m) => m.month === nowM);
  const curActual = Number(input.actualNetByMonth[nowM] ?? '0');
  const curTarget = Number(cur?.target ?? 0);
  let risk: SavingsProgress['risk'] = 'ok';
  if (cur && curTarget === 0 && cur.isPromo) risk = 'promo';
  else if (curTarget > 0 && curActual < curTarget * 0.5) risk = 'behind';
  else if (curTarget > 0 && curActual < curTarget) risk = 'warn';
  // 按速预测:已过月日均结余 × 剩余天数(简化:按月均外推)
  const elapsed = Math.max(1, input.now.getMonth() + 1);
  const projected = (Number(saved) / elapsed * 12).toFixed(2);
  return { saved, ratePct, projected, risk };
}

/** 节流建议(P1-2/SP-FR-06):Top 分类月均 × 三档压缩(10/20/30%),金额纯函数产出 */
export function suggestCutbacks(topCategories: Array<{ categoryId: string | null; avgAmount: string }>): Array<{
  categoryId: string | null;
  avgAmount: string;
  cut10: string;
  cut20: string;
  cut30: string;
}> {
  return topCategories.slice(0, 3).map((c) => {
    const a = Number(c.avgAmount);
    return { categoryId: c.categoryId, avgAmount: c.avgAmount, cut10: (a * 0.1).toFixed(2), cut20: (a * 0.2).toFixed(2), cut30: (a * 0.3).toFixed(2) };
  });
}
