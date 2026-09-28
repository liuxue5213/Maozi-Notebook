import { z } from 'zod';

/** 支持的主币种(V1.0 单币种记账:主币种即记账币种;多币种折算 M01-F14 属 V2.0) */
export const SUPPORTED_CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'GBP', 'HKD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: SupportedCurrency = 'CNY';

export const CURRENCY_SYMBOLS: Record<SupportedCurrency, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  JPY: '¥',
  GBP: '£',
  HKD: 'HK$',
};

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code as SupportedCurrency] ?? code;
}

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);
