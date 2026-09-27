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
function parseAmountToken(text: string): string | null {
  // 1) 阿拉伯数字 + 可选单位(块/元/毛/分)
  const m = text.match(/(\d+(?:\.\d{1,2})?)\s*(?:块|元|块钱)?/);
  if (m) {
    const n = Number(m[1]);
    if (n > 0 && Number.isFinite(n)) return n.toFixed(2);
  }
  // 2) 纯中文数字:二十六 → 26;两块五 → 2.5
  const cn = text.match(/([零一二两三四五六七八九十百千]+)(?:块|元)(?:([零一二两三四五六七八九十]+))?/);
  if (cn) {
    const int = cnToInt(cn[1]);
    const frac = cn[2] ? (cnToInt(cn[2]) ?? 0) : 0;
    if (int !== null) return (int + frac / 10).toFixed(2);
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
  const amount = parseAmountToken(t);
  const isIncome = INCOME_RE.test(t);
  const cat = CATEGORY_RULES.find(([re]) => re.test(t));
  // 去掉金额片段,剩余文本作备注
  const note = t
    .replace(/(\d+(?:\.\d{1,2})?)\s*(?:块|元|块钱)?/g, '')
    .replace(/[零一二两三四五六七八九十百千]+(?:块|元)[零一二两三四五六七八九十]+?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    amount,
    isIncome,
    categoryKeyword: cat?.[1] ?? null,
    note,
  };
}
