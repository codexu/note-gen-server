CREATE TYPE "public"."device_authorization_status" AS ENUM('pending', 'approved', 'denied');--> statement-breakpoint
CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"device_id" uuid NOT NULL,
	"device_name" text NOT NULL,
	"platform" text NOT NULL,
	"encryption_public_key" text,
	"account_id" uuid,
	"status" "device_authorization_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_device_code_unique" ON "device_authorizations" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_user_code_unique" ON "device_authorizations" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "device_authorizations_expiry_idx" ON "device_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_authorizations_account_idx" ON "device_authorizations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_token_hash_unique" ON "web_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "web_sessions_account_idx" ON "web_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "web_sessions_expiry_idx" ON "web_sessions" USING btree ("expires_at");