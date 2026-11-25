CREATE TABLE "app_usage_daily" (
	"client_id" text NOT NULL,
	"person_id" text NOT NULL,
	"project_id" text DEFAULT '' NOT NULL,
	"day" text NOT NULL,
	"meter" text NOT NULL,
	"quantity" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "app_usage_daily_client_id_person_id_project_id_day_meter_pk" PRIMARY KEY("client_id","person_id","project_id","day","meter")
);
--> statement-breakpoint
ALTER TABLE "app_people" ADD COLUMN "out_of_credits_period" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "plans" jsonb;--> statement-breakpoint
ALTER TABLE "app_usage_daily" ADD CONSTRAINT "app_usage_daily_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_app_usage_daily_project" ON "app_usage_daily" USING btree ("project_id","day");