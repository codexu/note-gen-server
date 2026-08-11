CREATE TABLE "account_login_claim_conflicts" (
  "normalized_login_key" text NOT NULL, "candidate_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "candidate_identity_id" uuid REFERENCES "account_identities"("id") ON DELETE SET NULL,
  "candidate_kind" "account_login_claim_kind" NOT NULL, "status" text DEFAULT 'quarantined' NOT NULL,
  "resolution_ref" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "resolved_at" timestamp with time zone,
  PRIMARY KEY ("normalized_login_key", "candidate_account_id", "candidate_kind")
);
--> statement-breakpoint
CREATE INDEX "account_login_claim_conflicts_status_idx" ON "account_login_claim_conflicts" ("status", "created_at");
