CREATE TYPE "deployment_mode" AS ENUM ('hosted', 'self-hosted');
--> statement-breakpoint
CREATE TYPE "registration_policy" AS ENUM ('bootstrap', 'disabled', 'invitation', 'public');
--> statement-breakpoint
CREATE TYPE "self_hosted_lifecycle" AS ENUM ('uninitialized', 'ready');
--> statement-breakpoint
CREATE TABLE "deployment_settings" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "deployment_mode" "deployment_mode" NOT NULL,
  "registration_policy" "registration_policy" NOT NULL,
  "self_hosted_lifecycle" "self_hosted_lifecycle",
  "admin_repair_required" boolean DEFAULT false NOT NULL,
  "configuration_revision" bigint DEFAULT 1 NOT NULL,
  "initialized_at" timestamp with time zone,
  "initialized_by_account_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deployment_settings_singleton" CHECK ("id" = true),
  CONSTRAINT "deployment_settings_mode_lifecycle" CHECK (
    ("deployment_mode" = 'hosted' AND "self_hosted_lifecycle" IS NULL)
    OR ("deployment_mode" = 'self-hosted' AND "self_hosted_lifecycle" IS NOT NULL)
  )
);
