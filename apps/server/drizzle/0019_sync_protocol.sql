ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "parent_object_id" uuid;
--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "name_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "object_versions" ADD COLUMN IF NOT EXISTS "parent_object_id" uuid;
--> statement-breakpoint
ALTER TABLE "object_versions" ADD COLUMN IF NOT EXISTS "name_ciphertext" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_v2_commands" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "command_id" uuid NOT NULL,
  "source_device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "request_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "command_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_commands_created_idx" ON "sync_v2_commands" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_v2_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "sequence" bigint NOT NULL,
  "event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "command_id" uuid NOT NULL,
  "source_device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "event_type" text NOT NULL,
  "object_id" uuid,
  "document_id" text,
  "document_sequence" bigint,
  "key_version" integer,
  "ciphertext" text,
  "ciphertext_hash" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_v2_events_workspace_sequence_unique" ON "sync_v2_events" ("workspace_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_v2_events_workspace_event_unique" ON "sync_v2_events" ("workspace_id", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_events_document_idx" ON "sync_v2_events" ("workspace_id", "document_id", "document_sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_events_created_idx" ON "sync_v2_events" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_v2_documents" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "document_id" text NOT NULL,
  "object_id" uuid NOT NULL,
  "kind" object_kind NOT NULL,
  "latest_document_sequence" bigint DEFAULT 0 NOT NULL,
  "checkpoint_document_sequence" bigint DEFAULT 0 NOT NULL,
  "checkpoint_id" uuid,
  "checkpoint_key_version" integer,
  "checkpoint_ciphertext" text,
  "checkpoint_ciphertext_hash" text,
  "materialized_revision" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "document_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_v2_documents_object_unique" ON "sync_v2_documents" ("workspace_id", "object_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_v2_updates" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "document_id" text NOT NULL,
  "document_sequence" bigint NOT NULL,
  "update_id" uuid NOT NULL,
  "event_sequence" bigint NOT NULL,
  "source_device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "key_version" integer NOT NULL,
  "ciphertext" text NOT NULL,
  "ciphertext_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "document_id", "document_sequence")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_v2_updates_id_unique" ON "sync_v2_updates" ("workspace_id", "update_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_updates_event_idx" ON "sync_v2_updates" ("workspace_id", "event_sequence");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_v2_checkpoints" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "checkpoint_id" uuid NOT NULL,
  "document_id" text NOT NULL,
  "object_id" uuid NOT NULL,
  "covers_document_sequence" bigint NOT NULL,
  "event_sequence" bigint NOT NULL,
  "materialized_revision" bigint,
  "key_version" integer NOT NULL,
  "ciphertext" text NOT NULL,
  "ciphertext_hash" text NOT NULL,
  "source_device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "checkpoint_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_checkpoints_document_idx" ON "sync_v2_checkpoints" ("workspace_id", "document_id", "event_sequence");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_v2_conflicts" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "conflict_id" uuid NOT NULL,
  "object_id" uuid NOT NULL,
  "kind" object_kind NOT NULL,
  "conflict_type" text NOT NULL,
  "status" text DEFAULT 'unresolved' NOT NULL,
  "expected_revision" bigint,
  "expected_document_sequence" bigint,
  "key_version" integer NOT NULL,
  "ciphertext" text NOT NULL,
  "ciphertext_hash" text NOT NULL,
  "created_sequence" bigint NOT NULL,
  "resolved_sequence" bigint,
  "resolved_by_device_id" uuid REFERENCES "devices"("id"),
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "conflict_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_conflicts_status_idx" ON "sync_v2_conflicts" ("workspace_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_conflicts_object_idx" ON "sync_v2_conflicts" ("workspace_id", "object_id");
--> statement-breakpoint
