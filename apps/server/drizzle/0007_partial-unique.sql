DROP INDEX "budget_item_uq";--> statement-breakpoint
DROP INDEX "member_ledger_user_uq";--> statement-breakpoint
DROP INDEX "pending_dedupe_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "budget_item_uq" ON "budget_items" USING btree ("budget_id","category_id") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "member_ledger_user_uq" ON "ledger_members" USING btree ("ledger_id","user_id") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_dedupe_uq" ON "pending_transactions" USING btree ("ledger_id","dedupe_hash") WHERE is_deleted = false;