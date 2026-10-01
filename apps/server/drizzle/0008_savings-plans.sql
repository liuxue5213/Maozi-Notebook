CREATE TABLE "savings_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_id" text NOT NULL,
	"name" text NOT NULL,
	"goal_amount" numeric(18, 4) NOT NULL,
	"period_type" text DEFAULT 'yearly' NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"expected_income" numeric(18, 4),
	"baseline_months" integer DEFAULT 6 NOT NULL,
	"allocation" text DEFAULT 'even' NOT NULL,
	"promo_months" jsonb,
	"promo_multiplier" numeric(4, 2),
	"exclude_oneoff" boolean DEFAULT false NOT NULL,
	"linked_account_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"client_version" integer DEFAULT 1 NOT NULL,
	"server_version" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "savings_ledger_idx" ON "savings_plans" USING btree ("ledger_id");--> statement-breakpoint
CREATE INDEX "savings_lv_idx" ON "savings_plans" USING btree ("ledger_id","server_version");