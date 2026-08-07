CREATE TABLE "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"account_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "device_pairings_token_hash_unique" ON "device_pairings" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "device_pairings_account_idx" ON "device_pairings" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "device_pairings_expiry_idx" ON "device_pairings" USING btree ("expires_at");
