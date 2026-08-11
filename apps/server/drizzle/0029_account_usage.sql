CREATE TYPE "usage_reservation_status" AS ENUM ('reserved', 'external_started', 'committed', 'released', 'expired', 'reconciling');
--> statement-breakpoint
CREATE TABLE "account_usage" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "active_object_bytes" bigint DEFAULT 0 NOT NULL, "active_crdt_bytes" bigint DEFAULT 0 NOT NULL,
  "active_blob_bytes" bigint DEFAULT 0 NOT NULL, "reserved_blob_bytes" bigint DEFAULT 0 NOT NULL, "retained_bytes" bigint DEFAULT 0 NOT NULL,
  "active_objects" bigint DEFAULT 0 NOT NULL, "active_devices" bigint DEFAULT 0 NOT NULL, "active_workspaces" bigint DEFAULT 0 NOT NULL,
  "revision" bigint DEFAULT 0 NOT NULL, "reconciled_at" timestamp with time zone, "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE, "metric" text NOT NULL, "quantity" bigint NOT NULL,
  "source_type" text NOT NULL, "source_id" text NOT NULL, "request_hash" text NOT NULL, "provider_upload_ref" text,
  "status" "usage_reservation_status" DEFAULT 'reserved' NOT NULL, "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reservations_workspace_source_unique" ON "usage_reservations" ("account_id", "workspace_id", "source_type", "source_id", "metric") WHERE "workspace_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reservations_account_source_unique" ON "usage_reservations" ("account_id", "source_type", "source_id", "metric") WHERE "workspace_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "usage_reservations_expiry_idx" ON "usage_reservations" ("status", "expires_at");
--> statement-breakpoint
CREATE TABLE "usage_events" (
  "id" bigserial PRIMARY KEY, "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL, "metric" text NOT NULL, "delta" bigint NOT NULL,
  "resulting_value" bigint, "source_type" text NOT NULL, "source_id" text NOT NULL, "request_hash" text NOT NULL,
  "idempotency_key" text NOT NULL, "occurred_at" timestamp with time zone DEFAULT now() NOT NULL, "billing_period" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_workspace_idempotency_unique" ON "usage_events" ("account_id", "workspace_id", "idempotency_key") WHERE "workspace_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_account_idempotency_unique" ON "usage_events" ("account_id", "idempotency_key") WHERE "workspace_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "usage_events_account_occurred_idx" ON "usage_events" ("account_id", "occurred_at");
