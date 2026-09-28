import { currencySymbol } from '@ledgerone/domain';
import { getBaseCurrency } from '../sync/api';

/** 当前主币种符号(M16/第 17 轮显示收口):渲染时读取偏好缓存,设置保存后切页生效 */
export function cur(): string {
  return currencySymbol(getBaseCurrency());
}
