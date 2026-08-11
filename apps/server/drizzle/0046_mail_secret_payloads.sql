CREATE TABLE "mail_secret_payloads" (
  "id" uuid PRIMARY KEY NOT NULL,
  "key_id" text NOT NULL,
  "ciphertext" text NOT NULL,
  "payload_version" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "erased_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mail_secret_payloads_version_check" CHECK ("payload_version" > 0)
);
--> statement-breakpoint
CREATE INDEX "mail_secret_payloads_expiry_idx" ON "mail_secret_payloads" ("expires_at");
