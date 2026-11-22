CREATE TABLE "app_github_installations" (
	"client_id" text NOT NULL,
	"scope" text NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_id" text NOT NULL,
	"state_nonce" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_github_installations_client_id_scope_pk" PRIMARY KEY("client_id","scope")
);
--> statement-breakpoint
ALTER TABLE "app_github_installations" ADD CONSTRAINT "app_github_installations_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;