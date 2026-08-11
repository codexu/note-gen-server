CREATE TYPE "key_envelope_status" AS ENUM ('active', 'revoked');
--> statement-breakpoint
ALTER TABLE "workspace_key_envelopes"
  ADD COLUMN "status" "key_envelope_status" DEFAULT 'active' NOT NULL,
  ADD COLUMN "revoked_at" timestamp with time zone,
  ADD COLUMN "replacement_idempotency_key" text,
  ADD COLUMN "replacement_request_hash" text;
--> statement-breakpoint
ALTER TABLE "workspace_key_envelopes" DROP CONSTRAINT "workspace_key_envelopes_recipient_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_key_envelopes_active_recipient_unique"
  ON "workspace_key_envelopes" ("workspace_id", "key_version", "envelope_type", "recipient_id") NULLS NOT DISTINCT
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_key_envelopes_replacement_idempotency_unique"
  ON "workspace_key_envelopes" ("workspace_id", "key_version", "replacement_idempotency_key")
  WHERE "replacement_idempotency_key" IS NOT NULL;
