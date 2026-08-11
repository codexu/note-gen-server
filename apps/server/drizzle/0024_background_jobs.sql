CREATE TYPE "background_job_status" AS ENUM ('pending', 'running', 'succeeded', 'dead_letter', 'cancelled');
--> statement-breakpoint
CREATE TYPE "outbox_message_status" AS ENUM ('pending', 'sending', 'sent', 'dead_letter', 'delivery_unknown');
--> statement-breakpoint
CREATE TABLE "background_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" text NOT NULL, "category" text NOT NULL,
  "status" "background_job_status" DEFAULT 'pending' NOT NULL,
  "payload" jsonb NOT NULL, "payload_version" integer NOT NULL, "request_hash" text NOT NULL,
  "queue_generation" integer DEFAULT 1 NOT NULL, "min_handler_version" integer DEFAULT 1 NOT NULL,
  "result" jsonb, "error_code" text, "idempotency_key" text NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL, "max_attempts" integer DEFAULT 10 NOT NULL,
  "scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_at" timestamp with time zone, "locked_by" text, "lease_expires_at" timestamp with time zone,
  "actor_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "target_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone, "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_idempotency_unique" ON "background_jobs" ("type", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "background_jobs_claim_idx" ON "background_jobs" ("status", "scheduled_at");
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel" text NOT NULL, "template_or_event" text NOT NULL, "recipient_ref" text NOT NULL,
  "payload" jsonb NOT NULL, "payload_version" integer NOT NULL, "secret_payload_ref" text,
  "request_hash" text NOT NULL, "idempotency_key" text NOT NULL,
  "status" "outbox_message_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL, "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "provider_message_id" text, "last_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_messages_idempotency_unique" ON "outbox_messages" ("channel", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "outbox_messages_claim_idx" ON "outbox_messages" ("status", "next_attempt_at");
