CREATE TYPE "data_request_type" AS ENUM ('access','export','correct','delete','restrict','object');
--> statement-breakpoint
CREATE TYPE "data_request_status" AS ENUM ('submitted','identity_check','queued','processing','awaiting_user','completed','rejected','canceled','held','failed');
--> statement-breakpoint
CREATE TYPE "deletion_case_status" AS ENUM ('requested','cooling_off','scheduled','held','purging','completed','canceled','failed');
--> statement-breakpoint
CREATE TYPE "deletion_fence_state" AS ENUM ('cooling_off','scheduled','purging','completed','canceled');
--> statement-breakpoint
CREATE TYPE "deletion_step_state" AS ENUM ('pending','running','completed','failed','skipped');
--> statement-breakpoint
CREATE TABLE "policy_documents" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,"type" text NOT NULL,"version" text NOT NULL,"locale" text NOT NULL,"content_ref" text NOT NULL,"canonicalization_version" integer NOT NULL,"content_hash" text NOT NULL,"effective_at" timestamp with time zone NOT NULL,"requires_reacceptance" boolean DEFAULT false NOT NULL,"retired_at" timestamp with time zone);
--> statement-breakpoint
CREATE UNIQUE INDEX "policy_documents_version_locale_unique" ON "policy_documents" ("type","version","locale");
--> statement-breakpoint
CREATE TABLE "policy_acceptances" ("id" bigserial PRIMARY KEY,"account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,"subject_hash" text NOT NULL,"subject_snapshot" jsonb NOT NULL,"policy_document_id" uuid NOT NULL REFERENCES "policy_documents"("id") ON DELETE RESTRICT,"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,"ip_prefix_hash" text,"user_agent_family" text,"evidence_version" integer NOT NULL);
--> statement-breakpoint
CREATE INDEX "policy_acceptances_subject_idx" ON "policy_acceptances" ("subject_hash","accepted_at");
--> statement-breakpoint
CREATE TABLE "data_requests" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,"account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,"subject_hash" text NOT NULL,"client_idempotency_key" text NOT NULL,"request_hash" text NOT NULL,"type" "data_request_type" NOT NULL,"status" "data_request_status" DEFAULT 'submitted' NOT NULL,"request_channel" text NOT NULL,"due_at" timestamp with time zone,"verified_at" timestamp with time zone,"completed_at" timestamp with time zone,"reason_code" text,"result_ref" text,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "data_requests_subject_idempotency_unique" ON "data_requests" ("subject_hash","client_idempotency_key");
--> statement-breakpoint
CREATE INDEX "data_requests_status_idx" ON "data_requests" ("status","created_at");
--> statement-breakpoint
CREATE TABLE "account_deletion_cases" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,"account_id" uuid,"subject_hash" text NOT NULL,"status" "deletion_case_status" DEFAULT 'requested' NOT NULL,"requested_at" timestamp with time zone DEFAULT now() NOT NULL,"cancel_until" timestamp with time zone,"purge_after" timestamp with time zone,"completed_at" timestamp with time zone,"cancel_credential_hash" text,"purge_manifest_ref" text,"purge_manifest_hash" text,"failure_code" text,"created_at" timestamp with time zone DEFAULT now() NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_cases_active_account_unique" ON "account_deletion_cases" ("account_id") WHERE "account_id" IS NOT NULL AND "status" IN ('requested','cooling_off','scheduled','held','purging');
--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_cases_active_subject_unique" ON "account_deletion_cases" ("subject_hash") WHERE "status" IN ('requested','cooling_off','scheduled','held','purging');
--> statement-breakpoint
CREATE TABLE "account_deletion_fences" ("account_uuid" uuid PRIMARY KEY,"subject_hash" text NOT NULL,"generation" uuid DEFAULT gen_random_uuid() NOT NULL,"state" "deletion_fence_state" NOT NULL,"hold_revision" bigint DEFAULT 0 NOT NULL,"blocks_domain_writes" boolean DEFAULT true NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,"completed_at" timestamp with time zone);
--> statement-breakpoint
CREATE TABLE "deletion_case_steps" ("deletion_case_id" uuid NOT NULL REFERENCES "account_deletion_cases"("id") ON DELETE CASCADE,"handler" text NOT NULL,"state" "deletion_step_state" DEFAULT 'pending' NOT NULL,"attempt" integer DEFAULT 0 NOT NULL,"idempotency_key" text NOT NULL,"external_ref" text,"last_error_code" text,"completed_at" timestamp with time zone,PRIMARY KEY("deletion_case_id","handler"));
--> statement-breakpoint
CREATE TABLE "deletion_ledger" ("subject_hash" text PRIMARY KEY,"hash_key_id" text NOT NULL,"deletion_case_id" uuid NOT NULL,"completed_at" timestamp with time zone NOT NULL,"minimum_backup_generation" bigint NOT NULL,"minimum_database_lsn" text,"receipt_hash" text NOT NULL);
