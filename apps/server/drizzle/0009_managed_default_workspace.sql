ALTER TYPE "public"."key_envelope_type" ADD VALUE IF NOT EXISTS 'managed';
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;

WITH "ranked_workspaces" AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "account_id"
    ORDER BY "created_at" ASC, "id" ASC
  ) AS "position"
  FROM "workspaces"
  WHERE "deleted_at" IS NULL
)
UPDATE "workspaces"
SET "is_default" = true
FROM "ranked_workspaces"
WHERE "workspaces"."id" = "ranked_workspaces"."id"
  AND "ranked_workspaces"."position" = 1;

CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_active_default_unique"
ON "workspaces" USING btree ("account_id")
WHERE "is_default" = true AND "deleted_at" IS NULL;
