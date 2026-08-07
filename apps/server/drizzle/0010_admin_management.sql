ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "is_admin" boolean DEFAULT false NOT NULL;

WITH "first_account" AS (
  SELECT "id"
  FROM "accounts"
  WHERE "disabled_at" IS NULL
  ORDER BY "created_at" ASC, "id" ASC
  LIMIT 1
)
UPDATE "accounts"
SET "is_admin" = true
FROM "first_account"
WHERE "accounts"."id" = "first_account"."id"
  AND NOT EXISTS (
    SELECT 1 FROM "accounts"
    WHERE "is_admin" = true
      AND "disabled_at" IS NULL
  );

CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "actor_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "admin_audit_logs_actor_idx"
ON "admin_audit_logs" USING btree ("actor_account_id", "created_at");

CREATE INDEX IF NOT EXISTS "admin_audit_logs_created_idx"
ON "admin_audit_logs" USING btree ("created_at");
