-- 0019 may already be recorded in development databases created before object
-- hierarchy metadata was added to that migration. Reconcile those columns here
-- before creating the sibling-name index.
ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "parent_object_id" uuid;
--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "name_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "object_versions" ADD COLUMN IF NOT EXISTS "parent_object_id" uuid;
--> statement-breakpoint
ALTER TABLE "object_versions" ADD COLUMN IF NOT EXISTS "name_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "name_blind_index" text;
--> statement-breakpoint
ALTER TABLE "object_versions" ADD COLUMN IF NOT EXISTS "name_blind_index" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "objects_sibling_name_blind_idx"
  ON "objects" ("workspace_id", "parent_object_id", "name_blind_index")
  WHERE "deleted_at" IS NULL AND "name_blind_index" IS NOT NULL;
