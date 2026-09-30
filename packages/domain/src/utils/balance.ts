import { addAmount, subAmount } from './money';
import type { AccountRow, TransactionRow } from '../types';
import type { AccountType } from '../enums';

export const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set(['credit_card', 'payable']);

export function isLiability(type: AccountType): boolean {
  return LIABILITY_TYPES.has(type);
}

/**
 * 账户余额 = 初始余额 + 收入 − 支出 + 转入 − 转出(PRD M02-F02,余额由流水推导)。
 * 软删除行不计入;转账双边生效。
 */
export function accountBalance(initialBalance: string, accountId: string, txs: TransactionRow[]): string {
  let delta = '0';
  for (const t of txs) {
    if (t.is_deleted) continue;
    if (t.account_id === accountId) {
      if (t.type === 'income') delta = addAmount(delta, t.amount_base);
      else delta = subAmount(delta, t.amount_base); // 支出与转出都减少本账户
    } else if (t.type === 'transfer' && t.to_account_id === accountId) {
      delta = addAmount(delta, t.amount_base); // 转入
    }
  }
  return addAmount(initialBalance, delta);
}

export interface NetWorthSummary {
  assets: string;
  liabilities: string;
  /** 净值 = 资产总额 − 负债总额(PRD 0.4) */
  net: string;
  balances: Map<string, string>;
}

/** 全账户余额 + 资产/负债/净值汇总;归档账户与「不计入净值」账户不进汇总但仍返回余额 */
export function computeNetWorth(accounts: AccountRow[], txs: TransactionRow[]): NetWorthSummary {
  const balances = new Map<string, string>();
  let assets = '0';
  let liabilitiesRaw = '0'; // 负债账户余额之和,通常为负(欠款)
  for (const a of accounts) {
    const b = accountBalance(a.initial_balance, a.id, txs);
    balances.set(a.id, b);
    // P1-5(Review):软删账户不计入净值 —— 调用方漏过滤时兜底(与 Web 端显式过滤双保险)
    if (a.is_archived || a.is_deleted || !a.include_in_net) continue;
    if (isLiability(a.type)) liabilitiesRaw = addAmount(liabilitiesRaw, b);
    else assets = addAmount(assets, b);
  }
  const liabilities = subAmount('0', liabilitiesRaw); // 取正值口径,与「负债总额」表述一致
  return { assets, liabilities, net: subAmount(assets, liabilities), balances };
}
