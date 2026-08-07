CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
  "scope" text NOT NULL,
  "rate_key" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "hits" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "rate_limit_buckets_pk" PRIMARY KEY("scope", "rate_key", "window_start")
);

CREATE INDEX IF NOT EXISTS "rate_limit_buckets_expiry_idx"
ON "rate_limit_buckets" USING btree ("expires_at");

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "accounts_login_trgm_idx" ON "accounts" USING gin ("login" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "devices_name_trgm_idx" ON "devices" USING gin ("name" gin_trgm_ops);
