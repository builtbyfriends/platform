CREATE TABLE "app_wallet_use" (
	"client_id" text NOT NULL,
	"payer_id" text NOT NULL,
	"person_id" text NOT NULL,
	"period" text NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "app_wallet_use_client_id_payer_id_period_person_id_pk" PRIMARY KEY("client_id","payer_id","period","person_id")
);
--> statement-breakpoint
ALTER TABLE "app_wallet_use" ADD CONSTRAINT "app_wallet_use_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;