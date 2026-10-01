CREATE TABLE `accounts` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`name` varchar(191) NOT NULL,
	`type` varchar(191) NOT NULL DEFAULT 'cash',
	`initial_balance` decimal(18,4) NOT NULL DEFAULT '0',
	`initial_date` bigint NOT NULL,
	`currency` varchar(191) NOT NULL DEFAULT 'CNY',
	`include_in_net` boolean NOT NULL DEFAULT true,
	`is_archived` boolean NOT NULL DEFAULT false,
	`sort` int NOT NULL DEFAULT 0,
	`credit_bill_day` int,
	`credit_due_day` int,
	`credit_limit` decimal(18,4),
	`balance_cached` decimal(18,4),
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` varchar(128) NOT NULL,
	`transaction_id` varchar(128) NOT NULL,
	`file_key` text NOT NULL,
	`width` int,
	`height` int,
	`size` int,
	`sha256` varchar(191),
	`upload_status` varchar(191) NOT NULL DEFAULT 'local',
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128),
	`actor_user_id` varchar(128),
	`action` varchar(191) NOT NULL,
	`target_entity` varchar(191),
	`summary` json,
	`created_at` bigint NOT NULL,
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `budget_items` (
	`id` varchar(128) NOT NULL,
	`budget_id` varchar(128) NOT NULL,
	`category_id` varchar(128) NOT NULL,
	`amount` decimal(18,4) NOT NULL,
	`used_cached` decimal(18,4),
	`active_key` int GENERATED ALWAYS AS (case when is_deleted = 0 then 1 else null end) VIRTUAL,
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `budget_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `budget_item_uq` UNIQUE(`budget_id`,`category_id`,`active_key`)
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`period_type` varchar(191) NOT NULL DEFAULT 'monthly',
	`period_start` bigint NOT NULL,
	`total_amount` decimal(18,4) NOT NULL,
	`currency` varchar(191) NOT NULL DEFAULT 'CNY',
	`rollover` boolean NOT NULL DEFAULT false,
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `budgets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`parent_id` varchar(128),
	`name` varchar(191) NOT NULL,
	`kind` varchar(191) NOT NULL DEFAULT 'expense',
	`icon` varchar(191) NOT NULL DEFAULT '📦',
	`color` varchar(191),
	`sort` int NOT NULL DEFAULT 0,
	`is_hidden` boolean NOT NULL DEFAULT false,
	`is_preset` boolean NOT NULL DEFAULT false,
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `categories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `debts` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`direction` varchar(191) NOT NULL,
	`counterparty` varchar(191) NOT NULL,
	`principal` decimal(18,4) NOT NULL,
	`repaid` decimal(18,4) NOT NULL DEFAULT '0',
	`due_at` bigint,
	`transaction_id` varchar(128),
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `debts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ledger_members` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`user_id` varchar(128) NOT NULL,
	`role` varchar(191) NOT NULL DEFAULT 'viewer',
	`nickname_in_ledger` varchar(191),
	`joined_at` bigint NOT NULL,
	`active_key` int GENERATED ALWAYS AS (case when is_deleted = 0 then 1 else null end) VIRTUAL,
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `ledger_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `member_ledger_user_uq` UNIQUE(`ledger_id`,`user_id`,`active_key`)
);
--> statement-breakpoint
CREATE TABLE `ledgers` (
	`id` varchar(128) NOT NULL,
	`owner_user_id` varchar(128) NOT NULL,
	`name` varchar(191) NOT NULL,
	`type` varchar(191) NOT NULL DEFAULT 'personal',
	`icon` varchar(191),
	`sort` int NOT NULL DEFAULT 0,
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `ledgers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `login_locks` (
	`email` varchar(191) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`locked_until` bigint NOT NULL DEFAULT 0,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `login_locks_email` PRIMARY KEY(`email`)
);
--> statement-breakpoint
CREATE TABLE `pending_transactions` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`source_type` varchar(191) NOT NULL DEFAULT 'import',
	`raw` text,
	`parsed` json,
	`confidence` decimal(4,3),
	`dedupe_hash` varchar(191),
	`status` varchar(191) NOT NULL DEFAULT 'pending',
	`active_key` int GENERATED ALWAYS AS (case when is_deleted = 0 then 1 else null end) VIRTUAL,
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `pending_transactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `pending_dedupe_uq` UNIQUE(`ledger_id`,`dedupe_hash`,`active_key`)
);
--> statement-breakpoint
CREATE TABLE `phone_codes` (
	`phone` varchar(191) NOT NULL,
	`code_hash` varchar(191) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`locked_until` bigint NOT NULL DEFAULT 0,
	`last_sent_at` bigint NOT NULL DEFAULT 0,
	`expires_at` bigint NOT NULL,
	`used` boolean NOT NULL DEFAULT false,
	`created_at` bigint NOT NULL,
	CONSTRAINT `phone_codes_phone` PRIMARY KEY(`phone`)
);
--> statement-breakpoint
CREATE TABLE `recurring_rules` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`amount` decimal(18,4) NOT NULL,
	`category_id` varchar(128),
	`account_id` varchar(128) NOT NULL,
	`note` text,
	`frequency` varchar(191) NOT NULL DEFAULT 'monthly',
	`interval` int NOT NULL DEFAULT 1,
	`next_run_at` bigint NOT NULL,
	`paused` boolean NOT NULL DEFAULT false,
	`last_run_at` bigint,
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `recurring_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` varchar(128) NOT NULL,
	`user_id` varchar(128) NOT NULL,
	`token_hash` varchar(191) NOT NULL,
	`expires_at` bigint NOT NULL,
	`revoked_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `refresh_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `reimbursements` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`title` varchar(191) NOT NULL,
	`status` varchar(191) NOT NULL DEFAULT 'pending',
	`total_amount` decimal(18,4) NOT NULL,
	`transaction_ids` json NOT NULL,
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `reimbursements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `savings_plans` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`name` varchar(191) NOT NULL,
	`goal_amount` decimal(18,4) NOT NULL,
	`period_type` varchar(191) NOT NULL DEFAULT 'yearly',
	`period_start` bigint NOT NULL,
	`period_end` bigint NOT NULL,
	`expected_income` decimal(18,4),
	`baseline_months` int NOT NULL DEFAULT 6,
	`allocation` varchar(191) NOT NULL DEFAULT 'even',
	`promo_months` json,
	`promo_multiplier` decimal(4,2),
	`exclude_oneoff` boolean NOT NULL DEFAULT false,
	`linked_account_id` varchar(128),
	`status` varchar(191) NOT NULL DEFAULT 'active',
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `savings_plans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sync_changes` (
	`id` varchar(128) NOT NULL,
	`user_id` varchar(128) NOT NULL,
	`entity` varchar(191) NOT NULL,
	`entity_id` varchar(128) NOT NULL,
	`op` varchar(191) NOT NULL,
	`client_version` int NOT NULL,
	`server_version` bigint NOT NULL,
	`conflict` boolean NOT NULL DEFAULT false,
	`payload` json,
	`created_at` bigint NOT NULL,
	CONSTRAINT `sync_changes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sync_seq` (
	`id` varchar(128) NOT NULL,
	`seq` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `sync_seq_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`name` varchar(191) NOT NULL,
	`color` varchar(191),
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `tags_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` varchar(128) NOT NULL,
	`tag_id` varchar(128) NOT NULL,
	CONSTRAINT `tx_tag_uq` UNIQUE(`transaction_id`,`tag_id`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` varchar(128) NOT NULL,
	`ledger_id` varchar(128) NOT NULL,
	`user_id` varchar(128) NOT NULL,
	`member_id` varchar(128),
	`type` varchar(191) NOT NULL,
	`amount` decimal(18,4) NOT NULL,
	`currency` varchar(191) NOT NULL DEFAULT 'CNY',
	`amount_base` decimal(18,4) NOT NULL,
	`exchange_rate` decimal(18,8),
	`category_id` varchar(128),
	`account_id` varchar(128) NOT NULL,
	`to_account_id` varchar(128),
	`happened_at` bigint NOT NULL,
	`note` text,
	`is_refunded` boolean NOT NULL DEFAULT false,
	`refund_of_id` varchar(128),
	`reimburse_status` varchar(191),
	`exclude_from_budget` boolean NOT NULL DEFAULT false,
	`attachment_count` int NOT NULL DEFAULT 0,
	`source` varchar(191) NOT NULL DEFAULT 'manual',
	`client_version` int NOT NULL DEFAULT 1,
	`server_version` bigint,
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(128) NOT NULL,
	`email` varchar(191),
	`phone` varchar(191),
	`password_hash` text,
	`nickname` varchar(191) NOT NULL DEFAULT '',
	`avatar_url` text,
	`base_currency` varchar(191) NOT NULL DEFAULT 'CNY',
	`version_seq` bigint NOT NULL DEFAULT 0,
	`status` varchar(191) NOT NULL DEFAULT 'active',
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`),
	CONSTRAINT `users_phone_unique` UNIQUE(`phone`)
);
--> statement-breakpoint
CREATE INDEX `account_ledger_idx` ON `accounts` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `account_lv_idx` ON `accounts` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `attachment_tx_idx` ON `attachments` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `audit_ledger_idx` ON `audit_logs` (`ledger_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `budget_ledger_idx` ON `budgets` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `budget_lv_idx` ON `budgets` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `category_ledger_idx` ON `categories` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `category_lv_idx` ON `categories` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `debt_ledger_idx` ON `debts` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `debt_lv_idx` ON `debts` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `member_user_idx` ON `ledger_members` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE INDEX `ledger_lv_idx` ON `ledgers` (`server_version`);--> statement-breakpoint
CREATE INDEX `pending_ledger_idx` ON `pending_transactions` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `pending_lv_idx` ON `pending_transactions` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `recurring_ledger_idx` ON `recurring_rules` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `recurring_lv_idx` ON `recurring_rules` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `refresh_user_idx` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `reimbursement_ledger_idx` ON `reimbursements` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `reimbursement_lv_idx` ON `reimbursements` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `savings_ledger_idx` ON `savings_plans` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `savings_lv_idx` ON `savings_plans` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `sync_change_user_idx` ON `sync_changes` (`user_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `tag_ledger_idx` ON `tags` (`ledger_id`);--> statement-breakpoint
CREATE INDEX `tag_lv_idx` ON `tags` (`ledger_id`,`server_version`);--> statement-breakpoint
CREATE INDEX `tx_ledger_happened_idx` ON `transactions` (`ledger_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `tx_category_happened_idx` ON `transactions` (`category_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `tx_account_idx` ON `transactions` (`account_id`);--> statement-breakpoint
CREATE INDEX `tx_lv_idx` ON `transactions` (`ledger_id`,`server_version`);