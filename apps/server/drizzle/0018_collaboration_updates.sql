CREATE TABLE IF NOT EXISTS "collaboration_updates" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "document_id" text NOT NULL,
  "source_device_id" uuid NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
  "update_payload" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collaboration_updates_document_idx"
  ON "collaboration_updates" ("workspace_id", "document_id", "id");
