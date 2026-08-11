CREATE TABLE "legal_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "reason_code" text NOT NULL,
  "authority" text NOT NULL DEFAULT 'platform-admin',
  "approved_by" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_by" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "released_at" timestamp with time zone,
  "release_reason_code" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "legal_holds_active_account_unique" ON "legal_holds" ("account_id") WHERE "released_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "legal_holds_account_idx" ON "legal_holds" ("account_id", "approved_at");
