/** 去重哈希 = hash(金额 + 分钟级时间 + 账户 + 商户)(PRD 5.2 / M05-F05) */
export async function dedupeHash(input: {
  amount: string;
  happenedAt: number;
  accountId: string;
  merchant?: string;
}): Promise<string> {
  // 金额定点归一化(上线全检 #27):'26.0' 与 '26.00' 视为同一金额
  const amount = String(parseFloat(Number(input.amount).toFixed(2)));
  const material = `${amount}|${Math.floor(input.happenedAt / 60000)}|${input.accountId}|${input.merchant ?? ''}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
