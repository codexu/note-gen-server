CREATE TABLE IF NOT EXISTS "admin_test_objects" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "object_id" uuid NOT NULL,
  "kind" "object_kind" NOT NULL,
  "created_by_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "admin_test_objects_pk" PRIMARY KEY("workspace_id", "object_id")
);
CREATE INDEX IF NOT EXISTS "admin_test_objects_created_idx"
ON "admin_test_objects" USING btree ("created_at");
