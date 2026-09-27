CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'cash' NOT NULL,
	"initial_balance" numeric(18, 4) DEFAULT '0' NOT NULL,
	"initial_date" bigint NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"include_in_net" boolean DEFAULT true NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"credit_bill_day" integer,
	"credit_due_day" integer,
	"credit_limit" numeric(18, 4),
	"balance_cached" numeric(18, 4),
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"file_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"size" integer,
	"sha256" text,
	"upload_status" text DEFAULT 'local' NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_entity" text,
	"summary" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_items" (
	"id" text PRIMARY KEY NOT NULL,
	"budget_id" text NOT NULL,
	"category_id" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"used_cached" numeric(18, 4),
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"period_type" text DEFAULT 'monthly' NOT NULL,
	"period_start" bigint NOT NULL,
	"total_amount" numeric(18, 4) NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"rollover" boolean DEFAULT false NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"kind" text DEFAULT 'expense' NOT NULL,
	"icon" text DEFAULT '📦' NOT NULL,
	"color" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_preset" boolean DEFAULT false NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debts" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"direction" text NOT NULL,
	"counterparty" text NOT NULL,
	"principal" numeric(18, 4) NOT NULL,
	"repaid" numeric(18, 4) DEFAULT '0' NOT NULL,
	"due_at" bigint,
	"transaction_id" text,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_members" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"nickname_in_ledger" text,
	"joined_at" bigint NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledgers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'personal' NOT NULL,
	"icon" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"source_type" text DEFAULT 'import' NOT NULL,
	"raw" text,
	"parsed" jsonb,
	"confidence" numeric(4, 3),
	"dedupe_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_codes" (
	"phone" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_sent_at" bigint DEFAULT 0 NOT NULL,
	"expires_at" bigint NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"category_id" text,
	"account_id" text NOT NULL,
	"note" text,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"next_run_at" bigint NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"last_run_at" bigint,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reimbursements" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_amount" numeric(18, 4) NOT NULL,
	"transaction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"op" text NOT NULL,
	"client_version" integer NOT NULL,
	"server_version" bigint NOT NULL,
	"conflict" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_tags" (
	"transaction_id" text NOT NULL,
	"tag_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"user_id" text NOT NULL,
	"member_id" text,
	"type" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"amount_base" numeric(18, 4) NOT NULL,
	"exchange_rate" numeric(18, 8),
	"category_id" text,
	"account_id" text NOT NULL,
	"to_account_id" text,
	"happened_at" bigint NOT NULL,
	"note" text,
	"is_refunded" boolean DEFAULT false NOT NULL,
	"refund_of_id" text,
	"reimburse_status" text,
	"exclude_from_budget" boolean DEFAULT false NOT NULL,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"phone" text,
	"password_hash" text,
	"nickname" text DEFAULT '' NOT NULL,
	"avatar_url" text,
	"base_currency" text DEFAULT 'CNY' NOT NULL,
	"version_seq" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE INDEX "account_ledger_idx" ON "accounts" USING btree ("ledger_id");--> statement-breakpoint
CREATE INDEX "attachment_tx_idx" ON "attachments" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "audit_ledger_idx" ON "audit_logs" USING btree ("ledger_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_item_uq" ON "budget_items" USING btree ("budget_id","category_id");--> statement-breakpoint
CREATE INDEX "budget_ledger_idx" ON "budgets" USING btree ("ledger_id");--> statement-breakpoint
CREATE INDEX "category_ledger_idx" ON "categories" USING btree ("ledger_id");--> statement-breakpoint
CREATE INDEX "debt_ledger_idx" ON "debts" USING btree ("ledger_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_ledger_user_uq" ON "ledger_members" USING btree ("ledger_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_dedupe_uq" ON "pending_transactions" USING btree ("dedupe_hash");--> statement-breakpoint
CREATE INDEX "pending_ledger_idx" ON "pending_transactions" USING btree ("ledger_id");--> statement-breakpoint
CREATE INDEX "recurring_ledger_idx" ON "recurring_rules" USING btree ("ledger_id");--> statement-breakpoint
CREATE INDEX "refresh_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reimbursement_ledger_idx" ON "reimbursements" USING btree ("ledger_id");--> statement-breakpoint
CREATE INDEX "sync_change_user_idx" ON "sync_changes" USING btree ("user_id","server_version");--> statement-breakpoint
CREATE INDEX "tag_ledger_idx" ON "tags" USING btree ("ledger_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tx_tag_uq" ON "transaction_tags" USING btree ("transaction_id","tag_id");--> statement-breakpoint
CREATE INDEX "tx_ledger_happened_idx" ON "transactions" USING btree ("ledger_id","happened_at");--> statement-breakpoint
CREATE INDEX "tx_category_happened_idx" ON "transactions" USING btree ("category_id","happened_at");--> statement-breakpoint
CREATE INDEX "tx_account_idx" ON "transactions" USING btree ("account_id");