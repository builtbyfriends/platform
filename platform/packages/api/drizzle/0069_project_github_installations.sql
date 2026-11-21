CREATE TABLE "project_github_installations" (
	"project_id" text NOT NULL,
	"scope" text NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_id" text NOT NULL,
	"state_nonce" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_github_installations_project_id_scope_pk" PRIMARY KEY("project_id","scope")
);
--> statement-breakpoint
ALTER TABLE "project_github_installations" ADD CONSTRAINT "project_github_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;