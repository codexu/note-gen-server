CREATE TYPE "backup_run_status" AS ENUM ('queued', 'preparing', 'draining', 'dumping', 'copying', 'verifying', 'ready', 'failed', 'deleting');
--> statement-breakpoint
CREATE TYPE "restore_drill_mode" AS ENUM ('verify-only', 'isolated-restore', 'full-drill');
--> statement-breakpoint
CREATE TYPE "restore_marker_mode" AS ENUM ('preserve', 'clone');
--> statement-breakpoint
CREATE TYPE "restore_sanitation_status" AS ENUM ('pending', 'running', 'complete', 'failed');
--> statement-breakpoint
CREATE TABLE "backup_policies" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "enabled" boolean DEFAULT false NOT NULL, "schedule" text NOT NULL, "target_ref" text NOT NULL, "retention" jsonb NOT NULL, "encryption_key_id" text, "created_by" uuid, "updated_by" uuid, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL);
--> statement-breakpoint
CREATE TABLE "backup_runs" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "job_id" uuid, "policy_id" uuid REFERENCES "backup_policies"("id") ON DELETE SET NULL, "status" "backup_run_status" DEFAULT 'queued' NOT NULL, "snapshot_at" timestamp with time zone, "manifest_ref" text, "database_bytes" bigint, "blob_count" bigint, "blob_bytes" bigint, "error_code" text, "checkpoint" jsonb, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "completed_at" timestamp with time zone);
--> statement-breakpoint
CREATE INDEX "backup_runs_status_idx" ON "backup_runs" ("status", "created_at");
--> statement-breakpoint
CREATE TABLE "restore_drills" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "backup_run_id" uuid NOT NULL REFERENCES "backup_runs"("id") ON DELETE RESTRICT, "mode" "restore_drill_mode" NOT NULL, "status" text NOT NULL, "checks" jsonb DEFAULT '{}'::jsonb NOT NULL, "actor_id" uuid, "started_at" timestamp with time zone, "completed_at" timestamp with time zone);
--> statement-breakpoint
CREATE TABLE "restore_markers" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "backup_id" uuid NOT NULL, "mode" "restore_marker_mode" NOT NULL, "old_sync_epoch" uuid, "new_sync_epoch" uuid NOT NULL, "restored_through_sequence_by_workspace" jsonb DEFAULT '{}'::jsonb NOT NULL, "sanitation_status" "restore_sanitation_status" DEFAULT 'pending' NOT NULL, "auth_epoch_after" bigint, "bootstrap_token_cutoff" timestamp with time zone, "bootstrap_reissue_required" boolean DEFAULT false NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "completed_at" timestamp with time zone);
--> statement-breakpoint
CREATE UNIQUE INDEX "restore_markers_new_epoch_unique" ON "restore_markers" ("new_sync_epoch");
