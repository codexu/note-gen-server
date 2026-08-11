CREATE TYPE "bootstrap_credential_source" AS ENUM ('cli', 'legacy_environment');
--> statement-breakpoint
CREATE TABLE "bootstrap_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" "bootstrap_credential_source" NOT NULL,
  "token_key_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_hint" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_credentials_token_hash_unique" ON "bootstrap_credentials" ("token_hash");
--> statement-breakpoint
CREATE INDEX "bootstrap_credentials_active_idx" ON "bootstrap_credentials" ("expires_at");
