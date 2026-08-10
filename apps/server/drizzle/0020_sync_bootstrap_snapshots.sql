CREATE TABLE IF NOT EXISTS "sync_v2_bootstrap_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "snapshot_sequence" bigint NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_bootstrap_sessions_workspace_idx"
  ON "sync_v2_bootstrap_sessions" ("workspace_id", "expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_v2_bootstrap_objects" (
  "session_id" uuid NOT NULL REFERENCES "sync_v2_bootstrap_sessions"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "object_id" uuid NOT NULL,
  "revision" bigint NOT NULL,
  "document_id" text,
  "latest_document_sequence" bigint,
  "checkpoint_document_sequence" bigint,
  "checkpoint_id" uuid,
  "checkpoint_key_version" integer,
  "checkpoint_ciphertext" text,
  "checkpoint_ciphertext_hash" text,
  "materialized_revision" bigint,
  PRIMARY KEY ("session_id", "object_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_bootstrap_objects_workspace_idx"
  ON "sync_v2_bootstrap_objects" ("workspace_id", "session_id", "object_id");
