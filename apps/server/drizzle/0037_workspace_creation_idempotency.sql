ALTER TABLE "workspaces"
  ADD COLUMN "creation_idempotency_key" text,
  ADD COLUMN "creation_request_hash" text;

CREATE UNIQUE INDEX "workspaces_account_creation_idempotency_unique"
  ON "workspaces" ("account_id", "creation_idempotency_key")
  WHERE "creation_idempotency_key" IS NOT NULL;
