DROP INDEX "idx_app_credit_grants_invoice";--> statement-breakpoint
DROP INDEX "idx_app_credit_grants_payment";--> statement-breakpoint
ALTER TABLE "app_credit_grants" ADD COLUMN "month_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_credit_grants_invoice" ON "app_credit_grants" USING btree ("client_id","stripe_invoice_id","month_index") WHERE "app_credit_grants"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_credit_grants_payment" ON "app_credit_grants" USING btree ("client_id","stripe_payment_intent_id","month_index") WHERE "app_credit_grants"."stripe_payment_intent_id" IS NOT NULL AND "app_credit_grants"."moved_from" IS NULL;