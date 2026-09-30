CREATE TABLE "login_locks" (
	"email" text PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
