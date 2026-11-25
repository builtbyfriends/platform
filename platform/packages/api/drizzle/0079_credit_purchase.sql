CREATE TABLE "app_buyers" (
	"client_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_payment_method_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_buyers_client_id_buyer_id_livemode_pk" PRIMARY KEY("client_id","buyer_id","livemode")
);
--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "top_up" jsonb;--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "top_up_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "top_up_off_reason" text;--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "top_up_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "top_up_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "top_up_month" text;--> statement-breakpoint
ALTER TABLE "app_payers" ADD COLUMN "top_up_month_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "credit_purchase" jsonb;--> statement-breakpoint
ALTER TABLE "app_buyers" ADD CONSTRAINT "app_buyers_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;