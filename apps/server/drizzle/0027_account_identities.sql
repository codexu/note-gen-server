CREATE TYPE "account_identity_state" AS ENUM ('pending_verification', 'active', 'legacy_migration');
--> statement-breakpoint
CREATE TYPE "account_identity_kind" AS ENUM ('username', 'email');
--> statement-breakpoint
CREATE TYPE "account_login_claim_kind" AS ENUM ('legacy_username', 'username', 'email');
--> statement-breakpoint
CREATE TYPE "account_action_token_purpose" AS ENUM ('verify_email', 'reset_password', 'change_email');
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "identity_state" "account_identity_state" DEFAULT 'legacy_migration' NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "credential_epoch" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "account_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "kind" "account_identity_kind" NOT NULL, "identifier" text NOT NULL, "normalized_identifier" text NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL, "verified_at" timestamp with time zone, "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_identities_active_unique" ON "account_identities" ("kind", "normalized_identifier") WHERE "disabled_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "account_identities_account_idx" ON "account_identities" ("account_id");
--> statement-breakpoint
CREATE TABLE "account_login_claims" (
  "normalized_login_key" text PRIMARY KEY, "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "identity_id" uuid REFERENCES "account_identities"("id") ON DELETE RESTRICT, "kind" "account_login_claim_kind" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "released_at" timestamp with time zone, "reusable_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account_action_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "account_id" uuid REFERENCES "accounts"("id") ON DELETE CASCADE,
  "identity_id" uuid REFERENCES "account_identities"("id") ON DELETE CASCADE, "purpose" "account_action_token_purpose" NOT NULL,
  "token_key_id" text NOT NULL, "token_hash" text NOT NULL, "target_normalized" text, "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone, "revoked_at" timestamp with time zone, "requested_ip_hash" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_action_tokens_hash_unique" ON "account_action_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX "account_action_tokens_account_idx" ON "account_action_tokens" ("account_id", "expires_at");
