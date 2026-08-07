CREATE TABLE IF NOT EXISTS "admin_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "progress" integer DEFAULT 0 NOT NULL,
  "result" jsonb,
  "error" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "admin_jobs_created_idx" ON "admin_jobs" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "admin_jobs_status_idx" ON "admin_jobs" USING btree ("status");

CREATE TABLE IF NOT EXISTS "admin_backups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL REFERENCES "admin_jobs"("id") ON DELETE CASCADE,
  "filename" text NOT NULL,
  "size" bigint,
  "status" text DEFAULT 'creating' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "admin_backups_filename_unique" UNIQUE("filename")
);
