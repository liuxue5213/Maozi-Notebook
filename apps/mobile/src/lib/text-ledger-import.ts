import type { ParsedTextLedger } from '@ledgerone/domain';

export type PreparedTextLedgerEntry = ParsedTextLedger['entries'][number] & {
  happenedAt: number;
  occurrence: number;
};

/** Keep the month from the ledger heading and distinguish identical purchases on one day. */
export function prepareTextLedgerEntries(ledger: ParsedTextLedger): { entries: PreparedTextLedgerEntry[]; invalid: number } {
  if (ledger.month < 1 || ledger.month > 12) throw new Error('账本标题中的月份无效');
  const entries: PreparedTextLedgerEntry[] = [];
  let invalid = 0;
  // Match Web import's per-day slot so the same source file hashes identically across devices.
  const occurrences = new Map<number, number>();
  for (const entry of ledger.entries) {
    const date = new Date(ledger.year, ledger.month - 1, entry.day, 12);
    if (date.getFullYear() !== ledger.year || date.getMonth() !== ledger.month - 1 || date.getDate() !== entry.day) {
      invalid++;
      continue;
    }
    const occurrence = occurrences.get(entry.day) ?? 0;
    occurrences.set(entry.day, occurrence + 1);
    entries.push({ ...entry, happenedAt: date.getTime(), occurrence });
  }
  return { entries, invalid };
}
