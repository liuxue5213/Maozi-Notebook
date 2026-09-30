CREATE INDEX "account_lv_idx" ON "accounts" USING btree ("ledger_id","server_version");--> statement-breakpoint
CREATE INDEX "budget_lv_idx" ON "budgets" USING btree ("ledger_id","server_version");--> statement-breakpoint
CREATE INDEX "category_lv_idx" ON "categories" USING btree ("ledger_id","server_version");--> statement-breakpoint
CREATE INDEX "debt_lv_idx" ON "debts" USING btree ("ledger_id","server_version");--> statement-breakpoint
CREATE INDEX "ledger_lv_idx" ON "ledgers" USING btree ("server_version");--> statement-breakpoint
CREATE INDEX "pending_lv_idx" ON "pending_transactions" USING btree ("ledger_id","server_version");--> statement-breakpoint
CREATE INDEX "recurring_lv_idx" ON "recurring_rules" USING btree ("ledger_id","server_version");--> statement-breakpoint
CREATE INDEX "reimbursement_lv_idx" ON "reimbursements" USING btree ("ledger_id","server_version");--> statement-breakpoint
CREATE INDEX "tag_lv_idx" ON "tags" USING btree ("ledger_id","server_version");--> statement-breakpoint
CREATE INDEX "tx_lv_idx" ON "transactions" USING btree ("ledger_id","server_version");