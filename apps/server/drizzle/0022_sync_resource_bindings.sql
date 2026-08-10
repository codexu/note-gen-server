CREATE TABLE IF NOT EXISTS "sync_v2_resource_bindings" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "owner_object_id" uuid NOT NULL,
  "owner_revision" bigint NOT NULL,
  "resource_object_id" uuid NOT NULL,
  "resource_revision" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "owner_object_id", "owner_revision", "resource_object_id"),
  CONSTRAINT "sync_v2_resource_bindings_owner_version_fk"
    FOREIGN KEY ("workspace_id", "owner_object_id", "owner_revision")
    REFERENCES "object_versions"("workspace_id", "object_id", "revision") ON DELETE CASCADE,
  CONSTRAINT "sync_v2_resource_bindings_resource_version_fk"
    FOREIGN KEY ("workspace_id", "resource_object_id", "resource_revision")
    REFERENCES "object_versions"("workspace_id", "object_id", "revision")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_resource_bindings_resource_idx"
  ON "sync_v2_resource_bindings" ("workspace_id", "resource_object_id", "resource_revision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_v2_resource_bindings_owner_idx"
  ON "sync_v2_resource_bindings" ("workspace_id", "owner_object_id", "owner_revision");
