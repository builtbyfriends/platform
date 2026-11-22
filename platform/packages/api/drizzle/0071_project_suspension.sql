ALTER TABLE "projects" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "suspended_note" text;