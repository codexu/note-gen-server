CREATE TYPE "support_case_category" AS ENUM ('account', 'sync', 'device', 'encryption', 'billing', 'privacy', 'abuse', 'other');
--> statement-breakpoint
CREATE TYPE "support_case_severity" AS ENUM ('normal', 'high', 'urgent');
--> statement-breakpoint
CREATE TYPE "support_case_status" AS ENUM ('open', 'waiting_for_support', 'waiting_for_user', 'resolved', 'closed', 'spam');
--> statement-breakpoint
CREATE TYPE "support_case_source" AS ENUM ('web', 'client', 'email', 'staff', 'external');
--> statement-breakpoint
CREATE TYPE "support_message_author_type" AS ENUM ('account', 'staff', 'system');
--> statement-breakpoint
CREATE TYPE "support_message_visibility" AS ENUM ('customer', 'internal');
--> statement-breakpoint
CREATE TABLE "support_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "subject_hash" text NOT NULL,
  "account_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "category" "support_case_category" NOT NULL,
  "severity" "support_case_severity" DEFAULT 'normal' NOT NULL,
  "status" "support_case_status" DEFAULT 'open' NOT NULL,
  "subject" text NOT NULL,
  "source" "support_case_source" NOT NULL,
  "assigned_staff_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "assigned_staff_snapshot" jsonb,
  "last_message_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "case_id" uuid NOT NULL REFERENCES "support_cases"("id") ON DELETE RESTRICT,
  "author_type" "support_message_author_type" NOT NULL,
  "author_ref" text,
  "author_snapshot" jsonb,
  "visibility" "support_message_visibility" DEFAULT 'customer' NOT NULL,
  "body_ciphertext" text NOT NULL,
  "body_key_id" text NOT NULL,
  "body_encryption_version" integer NOT NULL,
  "body_format" text DEFAULT 'plain' NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "support_messages_encryption_version_check" CHECK ("body_encryption_version" > 0),
  CONSTRAINT "support_messages_key_id_check" CHECK (length("body_key_id") > 0)
);
--> statement-breakpoint
CREATE INDEX "support_cases_account_updated_idx" ON "support_cases" ("account_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "support_cases_queue_idx" ON "support_cases" ("status", "last_message_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_case_author_idempotency_unique" ON "support_messages" ("case_id", "author_type", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "support_messages_case_created_idx" ON "support_messages" ("case_id", "created_at");
