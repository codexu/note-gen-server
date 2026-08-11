CREATE TABLE "deletion_ledger_outbox" (
  "deletion_case_id" uuid PRIMARY KEY NOT NULL REFERENCES "account_deletion_cases"("id") ON DELETE RESTRICT,
  "subject_hash" text NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "payload_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "delivered_at" timestamp with time zone,
  "external_ref" text,
  "last_error_code" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "deletion_ledger_outbox_claim_idx" ON "deletion_ledger_outbox" ("status", "next_attempt_at");
--> statement-breakpoint
-- Earlier internal builds marked local ledger rows completed atomically. They
-- have no independently durable receipt, so replay them rather than treating
-- that local fact as an external-delivery acknowledgement.
INSERT INTO "deletion_ledger_outbox" ("deletion_case_id", "subject_hash", "idempotency_key", "payload_hash")
SELECT ledger."deletion_case_id", ledger."subject_hash", ledger."deletion_case_id" || ':v1:deletion-ledger', 'legacy-local-ledger'
FROM "deletion_ledger" ledger
ON CONFLICT ("deletion_case_id") DO NOTHING;
--> statement-breakpoint
UPDATE "account_deletion_cases" deletion_case
SET "status" = 'purging', "completed_at" = NULL
WHERE deletion_case."status" = 'completed'
  AND EXISTS (
    SELECT 1 FROM "deletion_ledger_outbox" outbox
    WHERE outbox."deletion_case_id" = deletion_case."id" AND outbox."status" = 'pending'
  );
