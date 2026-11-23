CREATE TABLE "app_credit_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"payer_id" text NOT NULL,
	"source" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"remaining_micros" bigint NOT NULL,
	"giver_id" text,
	"stripe_invoice_id" text,
	"stripe_payment_intent_id" text,
	"livemode" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_payers" (
	"client_id" text NOT NULL,
	"payer_id" text NOT NULL,
	"owed_micros" bigint DEFAULT 0 NOT NULL,
	"out_since" timestamp with time zone,
	CONSTRAINT "app_payers_client_id_payer_id_pk" PRIMARY KEY("client_id","payer_id")
);
--> statement-breakpoint
ALTER TABLE "app_usage_daily" ADD COLUMN "cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_credit_grants" ADD CONSTRAINT "app_credit_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_payers" ADD CONSTRAINT "app_payers_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_app_credit_grants_payer" ON "app_credit_grants" USING btree ("client_id","payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_credit_grants_invoice" ON "app_credit_grants" USING btree ("client_id","stripe_invoice_id") WHERE "app_credit_grants"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_credit_grants_payment" ON "app_credit_grants" USING btree ("client_id","stripe_payment_intent_id") WHERE "app_credit_grants"."stripe_payment_intent_id" IS NOT NULL;