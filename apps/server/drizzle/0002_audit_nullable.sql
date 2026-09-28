ALTER TABLE "audit_logs" ALTER COLUMN "ledger_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_logs" USING btree ("action","created_at");