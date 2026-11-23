ALTER TABLE "app_credit_grants" ADD COLUMN "taken_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_credit_grants" ADD COLUMN "voided_remaining_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_credit_grants" ADD COLUMN "voided_owed_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "blocked_reason" text;