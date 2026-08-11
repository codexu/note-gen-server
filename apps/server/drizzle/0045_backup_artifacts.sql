CREATE TABLE "backup_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "backup_run_id" uuid NOT NULL REFERENCES "backup_runs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "relative_path" text NOT NULL,
  "sha256" text NOT NULL,
  "size" bigint NOT NULL,
  "source_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "backup_artifacts_size_check" CHECK ("size" >= 0),
  CONSTRAINT "backup_artifacts_path_check" CHECK (length("relative_path") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "backup_artifacts_run_path_unique" ON "backup_artifacts" ("backup_run_id", "relative_path");
--> statement-breakpoint
CREATE INDEX "backup_artifacts_run_idx" ON "backup_artifacts" ("backup_run_id");
