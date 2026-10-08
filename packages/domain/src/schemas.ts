import { z } from 'zod';
import {
  ACCOUNT_TYPES, ATTACHMENT_UPLOAD_STATUSES, BUDGET_PERIOD_TYPES, CATEGORY_KINDS, DEBT_DIRECTIONS,
  LEDGER_ROLES, LEDGER_TYPES, PENDING_SOURCES, PENDING_STATUSES, RECURRING_FREQUENCIES,
  REIMBURSE_STATUSES, REIMBURSEMENT_STATUSES, TRANSACTION_SOURCES, TRANSACTION_TYPES,
} from './enums';
import type { EntityKind } from './sync-protocol';
import { AMOUNT_RE } from './utils/money';

const idStr = z.string().min(1);
const tsNum = z.number().int().nonnegative();
const amountStr = z.string().regex(AMOUNT_RE);
const nullStr = z.string().nullable().optional();
const nullTs = z.number().int().nonnegative().nullable().optional();

export const ledgerSchema = z.object({
  id: idStr,
  name: z.string().min(1).max(50),
  type: z.enum(LEDGER_TYPES),
  icon: nullStr,
  sort: z.number().int().nonnegative().default(0),
});

export const ledgerMemberSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  user_id: idStr,
  role: z.enum(LEDGER_ROLES),
  nickname_in_ledger: nullStr,
  joined_at: tsNum,
});

export const accountSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  name: z.string().min(1).max(50),
  type: z.enum(ACCOUNT_TYPES),
  initial_balance: amountStr.default('0'),
  initial_date: tsNum,
  currency: z.string().length(3).default('CNY'),
  include_in_net: z.boolean().default(true),
  is_archived: z.boolean().default(false),
  sort: z.number().int().nonnegative().default(0),
  credit_bill_day: z.number().int().min(1).max(31).nullable().optional(),
  credit_due_day: z.number().int().min(1).max(31).nullable().optional(),
  credit_limit: amountStr.nullable().optional(),
});

export const categorySchema = z.object({
  id: idStr,
  ledger_id: idStr,
  parent_id: z.string().nullable(),
  name: z.string().min(1).max(20),
  kind: z.enum(CATEGORY_KINDS),
  icon: z.string().max(10).default('📦'),
  color: nullStr,
  sort: z.number().int().nonnegative().default(0),
  is_hidden: z.boolean().default(false),
  is_preset: z.boolean().default(false),
});

export const tagSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  name: z.string().min(1).max(20),
  color: nullStr,
});

export const transactionSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  member_id: nullStr,
  type: z.enum(TRANSACTION_TYPES),
  amount: amountStr,
  currency: z.string().length(3).default('CNY'),
  amount_base: amountStr.optional(),
  exchange_rate: z.string().regex(/^-?\d{1,10}(\.\d{1,8})?$/).nullable().optional(),
  category_id: z.string().nullable().optional(),
  account_id: idStr,
  to_account_id: z.string().nullable().optional(),
  happened_at: tsNum,
  note: z.string().max(500).optional(),
  is_refunded: z.boolean().default(false),
  refund_of_id: nullStr,
  reimburse_status: z.enum(REIMBURSE_STATUSES).nullable().optional(),
  exclude_from_budget: z.boolean().default(false),
  attachment_count: z.number().int().nonnegative().default(0),
  source: z.enum(TRANSACTION_SOURCES).default('manual'),
  // 同步元字段透传(协议缺口修复 2026-10-09):此前 zod 默认剥离未声明字段,
  // 「恢复(软删→未删)」这类只改删除状态的上行会被剥成空变更而判 noop,
  // 导致回收站恢复/误删撤销无法跨端同步
  user_id: z.string().optional(),
  client_version: z.number().int().optional(),
  server_version: z.number().int().nullable().optional(),
  is_deleted: z.boolean().optional(),
  deleted_at: tsNum.nullable().optional(),
  created_at: tsNum.optional(),
  updated_at: tsNum.optional(),
});

export const budgetSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  period_type: z.enum(BUDGET_PERIOD_TYPES),
  period_start: tsNum,
  total_amount: amountStr,
  currency: z.string().length(3).default('CNY'),
  rollover: z.boolean().default(false),
});

/** 存钱计划(需求 V1.1-a,与预算正交:预算管支出上限,存钱管结余下限) */
export const savingsPlanSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  name: z.string().min(1).max(50),
  goal_amount: amountStr,
  period_type: z.enum(['yearly', 'monthly']),
  period_start: tsNum,
  period_end: tsNum,
  expected_income: amountStr.nullable().optional(),
  baseline_months: z.number().int().min(3).max(12).default(6),
  allocation: z.enum(['even', 'promo']).default('even'),
  /** 促销月数组(如 [6,11]),jsonb 存储 */
  promo_months: z.array(z.number().int().min(1).max(12)).nullable().optional(),
  promo_multiplier: z.coerce.number().min(1).max(3).optional(), // 客户端以字符串定点传输,归一为数值
  exclude_oneoff: z.boolean().default(false),
  linked_account_id: idStr.nullable().optional(),
  status: z.enum(['active', 'paused', 'achieved', 'archived']).default('active'),
});

export const budgetItemSchema = z.object({
  id: idStr,
  budget_id: idStr,
  category_id: idStr,
  amount: amountStr,
  used_cached: amountStr.nullable().optional(),
});

export const recurringRuleSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  amount: amountStr,
  category_id: z.string().nullable().optional(),
  account_id: idStr,
  note: nullStr,
  frequency: z.enum(RECURRING_FREQUENCIES),
  interval: z.number().int().positive().default(1),
  next_run_at: tsNum,
  paused: z.boolean().default(false),
  last_run_at: nullTs,
});

export const attachmentSchema = z.object({
  id: idStr,
  transaction_id: idStr,
  file_key: z.string().min(1),
  width: nullTs,
  height: nullTs,
  size: nullTs,
  sha256: nullStr,
  upload_status: z.enum(ATTACHMENT_UPLOAD_STATUSES).default('local'),
});

export const pendingTransactionSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  source_type: z.enum(PENDING_SOURCES),
  raw: nullStr,
  parsed: z.unknown().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  dedupe_hash: nullStr,
  status: z.enum(PENDING_STATUSES).default('pending'),
});

export const debtSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  direction: z.enum(DEBT_DIRECTIONS),
  counterparty: z.string().min(1).max(50),
  principal: amountStr,
  repaid: amountStr.default('0'),
  due_at: nullTs,
  transaction_id: nullStr,
});

export const reimbursementSchema = z.object({
  id: idStr,
  ledger_id: idStr,
  title: z.string().min(1).max(100),
  status: z.enum(REIMBURSEMENT_STATUSES),
  total_amount: amountStr,
  transaction_ids: z.array(z.string()).default([]),
});

export const entitySchemas: Record<EntityKind, z.ZodTypeAny> = {
  ledger: ledgerSchema,
  ledger_member: ledgerMemberSchema,
  account: accountSchema,
  category: categorySchema,
  tag: tagSchema,
  transaction: transactionSchema,
  budget: budgetSchema,
  savings_plan: savingsPlanSchema,
  budget_item: budgetItemSchema,
  recurring_rule: recurringRuleSchema,
  attachment: attachmentSchema,
  pending_transaction: pendingTransactionSchema,
  debt: debtSchema,
  reimbursement: reimbursementSchema,
};

/** 服务端入口统一净化:剥离未知字段,校验类型与取值 */
export function sanitizeEntityPayload(kind: EntityKind, payload: unknown): Record<string, unknown> {
  const parsed = entitySchemas[kind].parse(payload);
  return parsed as Record<string, unknown>;
}
