DROP INDEX "idx_app_credit_grants_payment";--> statement-breakpoint
ALTER TABLE "app_credit_grants" ADD COLUMN "moved_out_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_credit_grants" ADD COLUMN "moved_from" text;--> statement-breakpoint
ALTER TABLE "app_credit_grants" ADD COLUMN "move_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_credit_grants_move" ON "app_credit_grants" USING btree ("client_id","move_id","moved_from") WHERE "app_credit_grants"."move_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_credit_grants_payment" ON "app_credit_grants" USING btree ("client_id","stripe_payment_intent_id") WHERE "app_credit_grants"."stripe_payment_intent_id" IS NOT NULL AND "app_credit_grants"."moved_from" IS NULL;