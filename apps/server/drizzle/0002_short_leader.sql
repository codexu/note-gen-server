CREATE TYPE "public"."key_envelope_type" AS ENUM('passphrase', 'recovery', 'device');--> statement-breakpoint
CREATE TABLE "workspace_key_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"envelope_type" "key_envelope_type" NOT NULL,
	"recipient_id" text,
	"wrapped_key" text NOT NULL,
	"kdf_salt" text,
	"kdf_params" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_key_envelopes" ADD CONSTRAINT "workspace_key_envelopes_key_fk" FOREIGN KEY ("workspace_id","key_version") REFERENCES "public"."workspace_keys"("workspace_id","key_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_key_envelopes_key_idx" ON "workspace_key_envelopes" USING btree ("workspace_id","key_version");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_key_envelopes_recipient_unique" ON "workspace_key_envelopes" USING btree ("workspace_id","key_version","envelope_type","recipient_id");--> statement-breakpoint
ALTER TABLE "workspace_keys" DROP COLUMN "wrapped_key";--> statement-breakpoint
ALTER TABLE "workspace_keys" DROP COLUMN "kdf_salt";--> statement-breakpoint
ALTER TABLE "workspace_keys" DROP COLUMN "kdf_params";