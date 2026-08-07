ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;

WITH "first_active_account" AS (
  SELECT "id"
  FROM "accounts"
  WHERE "disabled_at" IS NULL
    AND "suspended_at" IS NULL
  ORDER BY "created_at" ASC, "id" ASC
  LIMIT 1
)
UPDATE "accounts"
SET "is_admin" = true
FROM "first_active_account"
WHERE "accounts"."id" = "first_active_account"."id"
  AND NOT EXISTS (
    SELECT 1 FROM "accounts"
    WHERE "is_admin" = true
      AND "disabled_at" IS NULL
      AND "suspended_at" IS NULL
  );
