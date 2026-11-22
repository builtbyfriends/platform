CREATE TABLE "app_usage_sources" (
	"client_id" text NOT NULL,
	"person_id" text NOT NULL,
	"period" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"ai_neurons" integer DEFAULT 0 NOT NULL,
	"sandbox_seconds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "app_usage_sources_client_id_person_id_period_model_source_pk" PRIMARY KEY("client_id","person_id","period","model","source")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "payer_person_id" text;--> statement-breakpoint
ALTER TABLE "app_usage_sources" ADD CONSTRAINT "app_usage_sources_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;