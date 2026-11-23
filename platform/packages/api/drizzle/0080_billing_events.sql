CREATE TABLE "app_billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"gave_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "low_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "events_url" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "events_secret" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "low_balance_micros" bigint DEFAULT 2000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_billing_events" ADD CONSTRAINT "app_billing_events_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_app_billing_events_due" ON "app_billing_events" USING btree ("next_attempt_at") WHERE "app_billing_events"."sent_at" IS NULL AND "app_billing_events"."gave_up_at" IS NULL;