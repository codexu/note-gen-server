CREATE TABLE "restore_credential_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "restore_marker_id" uuid NOT NULL REFERENCES "restore_markers"("id") ON DELETE RESTRICT,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "decision" text NOT NULL,
  "operator_kind" text DEFAULT 'local-operator' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "restore_credential_reviews_marker_account_unique" ON "restore_credential_reviews" ("restore_marker_id", "account_id");
