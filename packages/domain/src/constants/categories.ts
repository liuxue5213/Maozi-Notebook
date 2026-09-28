import type { CategoryKind } from '../enums';

export interface PresetCategoryDef {
  name: string;
  icon: string;
  children: string[];
}

/** 预置支出分类:12 个一级(M03-F01) */
export const PRESET_EXPENSE_CATEGORIES: PresetCategoryDef[] = [
  { name: '餐饮', icon: '🍜', children: ['早餐', '午餐', '晚餐', '零食饮料', '外卖'] },
  { name: '交通', icon: '🚌', children: ['公交地铁', '打车', '共享单车', '加油', '停车', '火车机票'] },
  { name: '购物', icon: '🛒', children: ['日用品', '服饰', '数码', '美妆', '家居', '网购'] },
  { name: '居住', icon: '🏠', children: ['房租', '水电燃气', '物业', '网络', '家具维修'] },
  { name: '通讯', icon: '📱', children: ['话费', '宽带', '流量', '软件订阅'] },
  { name: '娱乐', icon: '🎮', children: ['电影演出', '游戏', '运动健身', '旅行出游', 'KTV'] },
  { name: '医疗', icon: '💊', children: ['门诊', '药品', '体检', '保健'] },
  { name: '教育', icon: '📚', children: ['书籍', '课程', '培训', '文具'] },
  { name: '人情', icon: '🧧', children: ['红包', '礼物', '请客', '捐赠'] },
  { name: '宠物', icon: '🐾', children: ['宠物粮', '宠物医疗', '宠物用品'] },
  { name: '旅行', icon: '✈️', children: ['住宿', '门票', '交通', '纪念品'] },
  { name: '其他', icon: '📦', children: ['杂项', '损耗', '罚款'] },
];

/** 预置收入分类 */
export const PRESET_INCOME_CATEGORIES: PresetCategoryDef[] = [
  { name: '工资', icon: '💰', children: ['月工资', '奖金', '年终奖'] },
  { name: '理财', icon: '📈', children: ['利息', '基金股票分红'] },
  { name: '退款', icon: '↩️', children: ['购物退款', '报销到账'] },
  { name: '红包', icon: '🧧', children: ['收红包'] },
  { name: '其他收入', icon: '➕', children: [] },
];

