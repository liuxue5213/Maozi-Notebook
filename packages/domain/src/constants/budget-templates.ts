/** 预算模板(M04-F06):按一级分类名给额度,套用时由客户端按名匹配分类 */
export interface BudgetTemplateDef {
  key: string;
  name: string;
  description: string;
  total: string;
  /** 分类名 → 额度;未列出的分类不设额度 */
  items: Record<string, string>;
}

export const BUDGET_TEMPLATES: BudgetTemplateDef[] = [
  {
    key: 'student',
    name: '学生党',
    description: '餐饮为主,控制娱乐',
    total: '1500',
    items: { 餐饮: '800', 交通: '150', 购物: '200', 娱乐: '150', 通讯: '50', 学习教育: '100', 其他: '50' },
  },
  {
    key: 'worker',
    name: '上班族',
    description: '通勤 + 外卖 + 房租均衡',
    total: '6000',
    items: { 餐饮: '1800', 交通: '500', 居住: '2500', 购物: '500', 娱乐: '300', 通讯: '100', 其他: '300' },
  },
  {
    key: 'family',
    name: '家庭',
    description: '全品类家庭开支',
    total: '12000',
    items: { 餐饮: '3500', 交通: '800', 居住: '4500', 购物: '1200', 娱乐: '600', 医疗: '400', 教育: '600', 人情: '400' },
  },
];
