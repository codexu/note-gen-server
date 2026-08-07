ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "totp_secret" text;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "totp_enabled_at" timestamp with time zone;
