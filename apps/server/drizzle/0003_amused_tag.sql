CREATE TABLE "rate_limit_buckets" (
	"scope" text NOT NULL,
	"rate_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_scope_rate_key_window_start_pk" PRIMARY KEY("scope","rate_key","window_start")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expiry_idx" ON "rate_limit_buckets" USING btree ("expires_at");