CREATE TYPE "billing_provider_environment" AS ENUM ('test','live');
--> statement-breakpoint
CREATE TYPE "billing_plan_interval" AS ENUM ('month','year');
--> statement-breakpoint
CREATE TYPE "account_subscription_status" AS ENUM ('incomplete','trialing','active','past_due','grace','paused','ended','review');
--> statement-breakpoint
CREATE TYPE "entitlement_grant_source" AS ENUM ('promotion','support','migration','staff');
--> statement-breakpoint
CREATE TYPE "billing_webhook_event_status" AS ENUM ('pending','processing','processed','ignored','failed','dead_letter');
--> statement-breakpoint
CREATE TYPE "billing_checkout_status" AS ENUM ('pending_provider','open','completed','linked','expired','failed','reconciling');
--> statement-breakpoint
CREATE TABLE "billing_plan_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_key" text NOT NULL,
  "version" integer NOT NULL,
  "display_name" text NOT NULL,
  "currency" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "interval" "billing_plan_interval" NOT NULL,
  "entitlement_schema_version" integer NOT NULL,
  "entitlements" jsonb NOT NULL,
  "active_from" timestamp with time zone NOT NULL,
  "retired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_plan_versions_amount_check" CHECK ("amount_minor" >= 0),
  CONSTRAINT "billing_plan_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "billing_plan_versions_schema_check" CHECK ("entitlement_schema_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_versions_key_version_unique" ON "billing_plan_versions" ("plan_key","version");
--> statement-breakpoint
CREATE TABLE "billing_price_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_version_id" uuid NOT NULL REFERENCES "billing_plan_versions"("id") ON DELETE RESTRICT,
  "provider" text NOT NULL,
  "provider_environment" "billing_provider_environment" NOT NULL,
  "provider_price_id" text NOT NULL,
  "currency" text NOT NULL,
  "interval" "billing_plan_interval" NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_price_mappings_provider_price_unique" ON "billing_price_mappings" ("provider","provider_environment","provider_price_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_price_mappings_plan_provider_unique" ON "billing_price_mappings" ("plan_version_id","provider","provider_environment","currency","interval");
--> statement-breakpoint
CREATE TABLE "billing_customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "subject_hash" text NOT NULL,
  "provider" text NOT NULL,
  "provider_customer_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_provider_customer_unique" ON "billing_customers" ("provider","provider_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_account_unique" ON "billing_customers" ("account_id") WHERE "account_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "account_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "subject_hash" text NOT NULL,
  "provider" text NOT NULL,
  "provider_subscription_id" text NOT NULL,
  "plan_version_id" uuid NOT NULL REFERENCES "billing_plan_versions"("id") ON DELETE RESTRICT,
  "status" "account_subscription_status" NOT NULL,
  "is_current" boolean DEFAULT false NOT NULL,
  "provider_revision" text,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "grace_ends_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_subscriptions_provider_subscription_unique" ON "account_subscriptions" ("provider","provider_subscription_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "account_subscriptions_current_account_unique" ON "account_subscriptions" ("account_id") WHERE "account_id" IS NOT NULL AND "is_current";
--> statement-breakpoint
CREATE INDEX "account_subscriptions_account_status_idx" ON "account_subscriptions" ("account_id","status");
--> statement-breakpoint
CREATE TABLE "entitlement_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "source" "entitlement_grant_source" NOT NULL,
  "source_ref" text NOT NULL,
  "request_hash" text NOT NULL,
  "schema_version" integer NOT NULL,
  "entitlements" jsonb NOT NULL,
  "priority" integer NOT NULL,
  "starts_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "reason" text,
  "created_by" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "entitlement_grants_schema_check" CHECK ("schema_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_source_unique" ON "entitlement_grants" ("account_id","source","source_ref");
--> statement-breakpoint
CREATE INDEX "entitlement_grants_active_idx" ON "entitlement_grants" ("account_id","starts_at","expires_at");
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "signature_verified_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "payload_redacted" jsonb NOT NULL,
  "status" "billing_webhook_event_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "error_code" text,
  "processed_at" timestamp with time zone,
  PRIMARY KEY("provider","provider_event_id")
);
--> statement-breakpoint
CREATE INDEX "billing_webhook_events_claim_idx" ON "billing_webhook_events" ("status","next_attempt_at");
--> statement-breakpoint
CREATE TABLE "billing_checkout_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "provider_checkout_id" text,
  "subscription_id" uuid REFERENCES "account_subscriptions"("id") ON DELETE SET NULL,
  "price_mapping_id" uuid NOT NULL REFERENCES "billing_price_mappings"("id") ON DELETE RESTRICT,
  "plan_version_id" uuid NOT NULL REFERENCES "billing_plan_versions"("id") ON DELETE RESTRICT,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "status" "billing_checkout_status" DEFAULT 'pending_provider' NOT NULL,
  "expires_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_sessions_account_idempotency_unique" ON "billing_checkout_sessions" ("account_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_sessions_provider_checkout_unique" ON "billing_checkout_sessions" ("provider","provider_checkout_id") WHERE "provider_checkout_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_sessions_active_account_unique" ON "billing_checkout_sessions" ("account_id") WHERE "status" IN ('pending_provider','open','completed','reconciling');
--> statement-breakpoint
CREATE TABLE "billing_account_states" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "current_subscription_id" uuid REFERENCES "account_subscriptions"("id") ON DELETE SET NULL,
  "purchase_intent_id" uuid REFERENCES "billing_checkout_sessions"("id") ON DELETE SET NULL,
  "revision" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_account_states_current_or_intent_check" CHECK (NOT ("current_subscription_id" IS NOT NULL AND "purchase_intent_id" IS NOT NULL))
);
