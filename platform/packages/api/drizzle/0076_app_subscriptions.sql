ALTER TABLE "app_people" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "app_people" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_people" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;