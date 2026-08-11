CREATE TYPE "risk_restriction_subject_type" AS ENUM ('account', 'identity', 'device', 'ip_prefix');
--> statement-breakpoint
CREATE TYPE "risk_restriction_scope" AS ENUM ('registration', 'authentication', 'recovery', 'device', 'sync_write', 'blob', 'billing', 'all');
--> statement-breakpoint
CREATE TYPE "risk_restriction_action" AS ENUM ('challenge', 'lock', 'read_only', 'deny', 'review');
--> statement-breakpoint
CREATE TYPE "risk_restriction_source" AS ENUM ('automatic', 'staff', 'provider');
--> statement-breakpoint
CREATE TYPE "risk_provider_event_status" AS ENUM ('pending', 'processing', 'processed', 'ignored', 'failed', 'dead_letter');
--> statement-breakpoint
CREATE TABLE "risk_events" ("id" bigserial PRIMARY KEY, "event_type" text NOT NULL, "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL, "identity_hash" text, "device_id" uuid, "ip_prefix_hash" text, "user_agent_family" text, "request_id" text NOT NULL, "outcome" text NOT NULL, "reason_codes" text[] DEFAULT '{}'::text[] NOT NULL, "score" integer, "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL);
--> statement-breakpoint
CREATE INDEX "risk_events_account_created_idx" ON "risk_events" ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "risk_events_event_created_idx" ON "risk_events" ("event_type", "created_at");
--> statement-breakpoint
CREATE TABLE "risk_restrictions" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "subject_type" "risk_restriction_subject_type" NOT NULL, "subject_ref" text NOT NULL, "scope" "risk_restriction_scope" NOT NULL, "action" "risk_restriction_action" NOT NULL, "reason_code" text NOT NULL, "source" "risk_restriction_source" NOT NULL, "expires_at" timestamp with time zone, "created_by" uuid, "revoked_at" timestamp with time zone, "revoked_by" uuid, "created_at" timestamp with time zone DEFAULT now() NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "risk_restrictions_active_unique" ON "risk_restrictions" ("subject_type", "subject_ref", "scope", "action") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "risk_restrictions_subject_idx" ON "risk_restrictions" ("subject_type", "subject_ref", "expires_at");
--> statement-breakpoint
CREATE TABLE "challenge_consumptions" ("token_digest" text PRIMARY KEY, "digest_key_id" text NOT NULL, "provider" text NOT NULL, "action" text NOT NULL, "expected_hostname" text NOT NULL, "verified_claims_hash" text NOT NULL, "consumed_at" timestamp with time zone DEFAULT now() NOT NULL, "expires_at" timestamp with time zone NOT NULL);
--> statement-breakpoint
CREATE TABLE "risk_provider_events" ("provider" text NOT NULL, "provider_event_id" text NOT NULL, "signature_verified_at" timestamp with time zone NOT NULL, "payload_redacted" jsonb NOT NULL, "status" "risk_provider_event_status" DEFAULT 'pending' NOT NULL, "attempts" integer DEFAULT 0 NOT NULL, "next_attempt_at" timestamp with time zone, "lease_expires_at" timestamp with time zone, "processed_at" timestamp with time zone, "error_code" text, PRIMARY KEY ("provider", "provider_event_id"));
--> statement-breakpoint
CREATE INDEX "risk_provider_events_claim_idx" ON "risk_provider_events" ("status", "next_attempt_at");
