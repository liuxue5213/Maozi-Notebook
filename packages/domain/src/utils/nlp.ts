/**
 * 语音/自然语言记账解析(M01-F03 + I06):端侧规则引擎,解析结果必须经用户二次确认。
 * 例:「买咖啡 26 块」→ { amount: '26', categoryKeyword: '餐饮', isIncome: false }
 */

export interface VoiceParseResult {
  amount: string | null;
  isIncome: boolean;
  categoryKeyword: string | null;
  /** 剔除金额词后的剩余文本,可作备注 */
  note: string;
}

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/早餐|午餐|晚餐|午饭|晚饭|咖啡|奶茶|外卖|吃饭|餐|食|饮品|肯德基|麦当劳|星巴克/, '餐饮'],
  [/打车|滴滴|地铁|公交|加油|停车|火车|机票|高铁|出租|单车/, '交通'],
  [/买|购物|超市|衣服|鞋|数码|手机|电脑|日用品/, '购物'],
  [/房租|水电|燃气|物业|宽带/, '居住'],
  [/话费|流量|充值/, '通讯'],
  [/电影|游戏|健身|KTV|演出|旅游门票/, '娱乐'],
  [/药|看病|门诊|体检|医院/, '医疗'],
  [/书|课程|培训|学费|文具/, '教育'],
  [/红包|礼物|请客|随礼/, '人情'],
  [/猫粮|狗粮|宠物|疫苗/, '宠物'],
  [/酒店|机票|门票|旅行|度假/, '旅行'],
  [/工资|薪水|奖金|年终奖|理财|利息|分红|报销/, '工资'],
];

const INCOME_RE = /收到|收入|进账|到账|工资|奖金|报销|红包$|分红|利息/;

/** 中文数字(简)与单位 */
interface AmountHit {
  value: string;
  /** 命中的金额片段(从原文剔除后剩余作备注;日期/型号数字保留) */
  token: string;
}

/**
 * 金额识别(第 19 轮 P0-7 修复):
 * 1) 显式货币单位(数字+块/元)优先 —— 金额语义最强;
 * 2) 中文数字 + 单位(二十六块);
 * 3) 兜底:取**最后一个**不处于日期上下文(后跟 年/月/日/号/点)的裸数字。
 * 修复前取首个数字,「2026年9月买咖啡26块」→ 2026、「9月15日打车38元」→ 9(Review 实证)。
 */
function findAmount(text: string): AmountHit | null {
  const unit = text.match(/(\d+(?:\.\d{1,2})?)\s*(?:块钱|块|元)/);
  if (unit) {
    const n = Number(unit[1]);
    if (n > 0 && Number.isFinite(n)) return { value: n.toFixed(2), token: unit[0] };
  }
  const cn = text.match(/([零一二两三四五六七八九十百千]+)(?:块|元)(?:([零一二两三四五六七八九十]+))?/);
  if (cn) {
    const int = cnToInt(cn[1]);
    if (int !== null) {
      const frac = cn[2] ? (cnToInt(cn[2]) ?? 0) : 0;
      return { value: (int + frac / 10).toFixed(2), token: cn[0] };
    }
  }
  const bare = [...text.matchAll(/\d+(?:\.\d{1,2})?/g)].filter((m) => {
    const next = text[m.index! + m[0].length] ?? '';
    return !/[年月日号点]/.test(next);
  });
  const last = bare[bare.length - 1];
  if (last) {
    const n = Number(last[0]);
    if (n > 0 && Number.isFinite(n)) return { value: n.toFixed(2), token: last[0] };
  }
  return null;
}

function cnToInt(s: string): number | null {
  const digit: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unit: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let cur = 0;
  let matched = false;
  for (const ch of s) {
    if (digit[ch] !== undefined) {
      cur = digit[ch];
      matched = true;
    } else if (unit[ch] !== undefined) {
      total += (cur === 0 ? 1 : cur) * unit[ch];
      cur = 0;
      matched = true;
    }
  }
  total += cur;
  return matched ? total : null;
}

export function parseVoiceInput(text: string): VoiceParseResult {
  const t = text.trim();
  const hit = findAmount(t);
  const isIncome = INCOME_RE.test(t);
  const cat = CATEGORY_RULES.find(([re]) => re.test(t));
  // 只剔除金额片段本身(日期/型号数字保留在备注里;修复前全量剔数字导致「年月买咖啡」)
  const note = (hit ? t.replace(hit.token, '') : t)
    .replace(/[零一二两三四五六七八九十百千]+(?:块|元)[零一二两三四五六七八九十]+?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    amount: hit?.value ?? null,
    isIncome,
    categoryKeyword: cat?.[1] ?? null,
    note,
  };
}
