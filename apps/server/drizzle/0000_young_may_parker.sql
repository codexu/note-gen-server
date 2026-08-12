-- These search indexes use PostgreSQL's trigram operator classes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."account_action_token_purpose" AS ENUM('verify_email', 'reset_password', 'change_email');--> statement-breakpoint
CREATE TYPE "public"."account_identity_kind" AS ENUM('username', 'email');--> statement-breakpoint
CREATE TYPE "public"."account_identity_state" AS ENUM('pending_verification', 'active', 'legacy_migration');--> statement-breakpoint
CREATE TYPE "public"."account_login_claim_kind" AS ENUM('legacy_username', 'username', 'email');--> statement-breakpoint
CREATE TYPE "public"."account_subscription_status" AS ENUM('incomplete', 'trialing', 'active', 'past_due', 'grace', 'paused', 'ended', 'review');--> statement-breakpoint
CREATE TYPE "public"."background_job_status" AS ENUM('pending', 'running', 'succeeded', 'dead_letter', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."backup_run_status" AS ENUM('queued', 'preparing', 'draining', 'dumping', 'copying', 'verifying', 'ready', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."billing_checkout_status" AS ENUM('pending_provider', 'open', 'completed', 'linked', 'expired', 'failed', 'reconciling');--> statement-breakpoint
CREATE TYPE "public"."billing_plan_interval" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TYPE "public"."billing_provider_environment" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."billing_webhook_event_status" AS ENUM('pending', 'processing', 'processed', 'ignored', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."blob_state" AS ENUM('uploading', 'ready', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."bootstrap_credential_source" AS ENUM('cli', 'legacy_environment');--> statement-breakpoint
CREATE TYPE "public"."change_type" AS ENUM('upsert', 'delete');--> statement-breakpoint
CREATE TYPE "public"."data_request_status" AS ENUM('submitted', 'identity_check', 'queued', 'processing', 'awaiting_user', 'completed', 'rejected', 'canceled', 'held', 'failed');--> statement-breakpoint
CREATE TYPE "public"."data_request_type" AS ENUM('access', 'export', 'correct', 'delete', 'restrict', 'object');--> statement-breakpoint
CREATE TYPE "public"."deletion_case_status" AS ENUM('requested', 'cooling_off', 'scheduled', 'held', 'purging', 'completed', 'canceled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."deletion_fence_state" AS ENUM('cooling_off', 'scheduled', 'purging', 'completed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."deletion_step_state" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."deployment_mode" AS ENUM('hosted', 'self-hosted');--> statement-breakpoint
CREATE TYPE "public"."device_authorization_status" AS ENUM('pending', 'approved', 'denied');--> statement-breakpoint
CREATE TYPE "public"."entitlement_grant_source" AS ENUM('promotion', 'support', 'migration', 'staff');--> statement-breakpoint
CREATE TYPE "public"."invitation_actor_type" AS ENUM('account', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."key_envelope_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."key_envelope_type" AS ENUM('passphrase', 'recovery', 'device', 'managed');--> statement-breakpoint
CREATE TYPE "public"."maintenance_mode" AS ENUM('normal', 'read_only', 'write_drain', 'offline');--> statement-breakpoint
CREATE TYPE "public"."object_kind" AS ENUM('note', 'folder', 'asset', 'canvas', 'record', 'tag', 'mark', 'conversation', 'memory', 'setting', 'yjs-checkpoint', 'yjs-update');--> statement-breakpoint
CREATE TYPE "public"."outbox_message_status" AS ENUM('pending', 'sending', 'sent', 'dead_letter', 'delivery_unknown');--> statement-breakpoint
CREATE TYPE "public"."registration_policy" AS ENUM('bootstrap', 'disabled', 'invitation', 'public');--> statement-breakpoint
CREATE TYPE "public"."restore_drill_mode" AS ENUM('verify-only', 'isolated-restore', 'full-drill');--> statement-breakpoint
CREATE TYPE "public"."restore_marker_mode" AS ENUM('preserve', 'clone');--> statement-breakpoint
CREATE TYPE "public"."restore_sanitation_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."risk_provider_event_status" AS ENUM('pending', 'processing', 'processed', 'ignored', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."risk_restriction_action" AS ENUM('challenge', 'lock', 'read_only', 'deny', 'review');--> statement-breakpoint
CREATE TYPE "public"."risk_restriction_scope" AS ENUM('registration', 'authentication', 'recovery', 'device', 'sync_write', 'blob', 'billing', 'all');--> statement-breakpoint
CREATE TYPE "public"."risk_restriction_source" AS ENUM('automatic', 'staff', 'provider');--> statement-breakpoint
CREATE TYPE "public"."risk_restriction_subject_type" AS ENUM('account', 'identity', 'device', 'ip_prefix');--> statement-breakpoint
CREATE TYPE "public"."self_hosted_lifecycle" AS ENUM('uninitialized', 'ready');--> statement-breakpoint
CREATE TYPE "public"."step_up_actor_type" AS ENUM('account', 'staff');--> statement-breakpoint
CREATE TYPE "public"."support_case_category" AS ENUM('account', 'sync', 'device', 'encryption', 'billing', 'privacy', 'abuse', 'other');--> statement-breakpoint
CREATE TYPE "public"."support_case_severity" AS ENUM('normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."support_case_source" AS ENUM('web', 'client', 'email', 'staff', 'external');--> statement-breakpoint
CREATE TYPE "public"."support_case_status" AS ENUM('open', 'waiting_for_support', 'waiting_for_user', 'resolved', 'closed', 'spam');--> statement-breakpoint
CREATE TYPE "public"."support_message_author_type" AS ENUM('account', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."support_message_visibility" AS ENUM('customer', 'internal');--> statement-breakpoint
CREATE TYPE "public"."usage_reservation_status" AS ENUM('reserved', 'external_started', 'committed', 'released', 'expired', 'reconciling');--> statement-breakpoint
CREATE TABLE "account_action_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"identity_id" uuid,
	"purpose" "account_action_token_purpose" NOT NULL,
	"token_key_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"target_normalized" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"requested_ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_deletion_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"subject_hash" text NOT NULL,
	"status" "deletion_case_status" DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_until" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancel_credential_hash" text,
	"purge_manifest_ref" text,
	"purge_manifest_hash" text,
	"purge_manifest" jsonb,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_deletion_fences" (
	"account_uuid" uuid PRIMARY KEY NOT NULL,
	"subject_hash" text NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" "deletion_fence_state" NOT NULL,
	"hold_revision" bigint DEFAULT 0 NOT NULL,
	"blocks_domain_writes" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "account_identity_kind" NOT NULL,
	"identifier" text NOT NULL,
	"normalized_identifier" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_login_claim_conflicts" (
	"normalized_login_key" text NOT NULL,
	"candidate_account_id" uuid NOT NULL,
	"candidate_identity_id" uuid,
	"candidate_kind" "account_login_claim_kind" NOT NULL,
	"status" text DEFAULT 'quarantined' NOT NULL,
	"resolution_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "account_login_claim_conflicts_normalized_login_key_candidate_account_id_candidate_kind_pk" PRIMARY KEY("normalized_login_key","candidate_account_id","candidate_kind")
);
--> statement-breakpoint
CREATE TABLE "account_login_claims" (
	"normalized_login_key" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"identity_id" uuid,
	"kind" "account_login_claim_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"reusable_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account_service_audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_service_audit_events_actor_type_check" CHECK ("account_service_audit_events"."actor_type" in ('account', 'staff', 'system', 'webhook')),
	CONSTRAINT "account_service_audit_events_action_check" CHECK (length("account_service_audit_events"."action") > 0),
	CONSTRAINT "account_service_audit_events_target_type_check" CHECK (length("account_service_audit_events"."target_type") > 0)
);
--> statement-breakpoint
CREATE TABLE "account_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"subject_hash" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"status" "account_subscription_status" NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"provider_revision" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"grace_ends_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_usage" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"active_object_bytes" bigint DEFAULT 0 NOT NULL,
	"active_crdt_bytes" bigint DEFAULT 0 NOT NULL,
	"active_blob_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_blob_bytes" bigint DEFAULT 0 NOT NULL,
	"retained_bytes" bigint DEFAULT 0 NOT NULL,
	"active_objects" bigint DEFAULT 0 NOT NULL,
	"active_devices" bigint DEFAULT 0 NOT NULL,
	"active_workspaces" bigint DEFAULT 0 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text,
	"totp_enabled_at" timestamp with time zone,
	"is_admin" boolean DEFAULT false NOT NULL,
	"suspended_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"identity_state" "account_identity_state" DEFAULT 'legacy_migration' NOT NULL,
	"credential_epoch" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"size" bigint,
	"status" text DEFAULT 'creating' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_test_objects" (
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"kind" "object_kind" NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_test_objects_workspace_id_object_id_pk" PRIMARY KEY("workspace_id","object_id")
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"status" "background_job_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_version" integer NOT NULL,
	"request_hash" text NOT NULL,
	"queue_generation" integer DEFAULT 1 NOT NULL,
	"min_handler_version" integer DEFAULT 1 NOT NULL,
	"result" jsonb,
	"error_code" text,
	"idempotency_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"actor_account_id" uuid,
	"target_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "background_jobs_payload_version_check" CHECK ("background_jobs"."payload_version" > 0),
	CONSTRAINT "background_jobs_queue_generation_check" CHECK ("background_jobs"."queue_generation" > 0),
	CONSTRAINT "background_jobs_min_handler_version_check" CHECK ("background_jobs"."min_handler_version" > 0),
	CONSTRAINT "background_jobs_attempt_check" CHECK ("background_jobs"."attempt" >= 0),
	CONSTRAINT "background_jobs_max_attempts_check" CHECK ("background_jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "backup_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"relative_path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_artifacts_size_check" CHECK ("backup_artifacts"."size" >= 0),
	CONSTRAINT "backup_artifacts_path_check" CHECK (length("backup_artifacts"."relative_path") > 0)
);
--> statement-breakpoint
CREATE TABLE "backup_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"schedule" text NOT NULL,
	"target_ref" text NOT NULL,
	"retention" jsonb NOT NULL,
	"encryption_key_id" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation" bigserial NOT NULL,
	"job_id" uuid,
	"policy_id" uuid,
	"status" "backup_run_status" DEFAULT 'queued' NOT NULL,
	"snapshot_at" timestamp with time zone,
	"manifest_ref" text,
	"database_bytes" bigint,
	"blob_count" bigint,
	"blob_bytes" bigint,
	"error_code" text,
	"checkpoint" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "billing_account_states" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"current_subscription_id" uuid,
	"purchase_intent_id" uuid,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_account_states_current_or_intent_check" CHECK (not ("billing_account_states"."current_subscription_id" is not null and "billing_account_states"."purchase_intent_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "billing_checkout_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_checkout_id" text,
	"subscription_id" uuid,
	"price_mapping_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "billing_checkout_status" DEFAULT 'pending_provider' NOT NULL,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"subject_hash" text NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_key" text NOT NULL,
	"version" integer NOT NULL,
	"display_name" text NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"interval" "billing_plan_interval" NOT NULL,
	"entitlement_schema_version" integer NOT NULL,
	"entitlements" jsonb NOT NULL,
	"active_from" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plan_versions_amount_check" CHECK ("billing_plan_versions"."amount_minor" >= 0),
	CONSTRAINT "billing_plan_versions_version_check" CHECK ("billing_plan_versions"."version" > 0),
	CONSTRAINT "billing_plan_versions_schema_check" CHECK ("billing_plan_versions"."entitlement_schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_price_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_environment" "billing_provider_environment" NOT NULL,
	"provider_price_id" text NOT NULL,
	"currency" text NOT NULL,
	"interval" "billing_plan_interval" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_verified_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_redacted" jsonb NOT NULL,
	"status" "billing_webhook_event_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error_code" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_webhook_events_provider_provider_event_id_pk" PRIMARY KEY("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "blob_upload_parts" (
	"upload_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"size" bigint NOT NULL,
	"etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_upload_parts_upload_id_part_number_pk" PRIMARY KEY("upload_id","part_number")
);
--> statement-breakpoint
CREATE TABLE "blob_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"blob_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"provider_upload_id" text NOT NULL,
	"usage_reservation_id" uuid,
	"sync_epoch" uuid,
	"expected_size" bigint NOT NULL,
	"received_size" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completing_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"workspace_id" uuid NOT NULL,
	"blob_id" text NOT NULL,
	"size" bigint NOT NULL,
	"ciphertext_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"state" "blob_state" NOT NULL,
	"last_referenced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_workspace_id_blob_id_pk" PRIMARY KEY("workspace_id","blob_id")
);
--> statement-breakpoint
CREATE TABLE "bootstrap_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "bootstrap_credential_source" NOT NULL,
	"token_key_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bootstrap_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"snapshot_sequence" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_consumptions" (
	"token_digest" text PRIMARY KEY NOT NULL,
	"digest_key_id" text NOT NULL,
	"provider" text NOT NULL,
	"action" text NOT NULL,
	"expected_hostname" text NOT NULL,
	"verified_claims_hash" text NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"object_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"operation_id" uuid NOT NULL,
	"source_device_id" uuid NOT NULL,
	"change_type" "change_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"subject_hash" text NOT NULL,
	"client_idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"type" "data_request_type" NOT NULL,
	"status" "data_request_status" DEFAULT 'submitted' NOT NULL,
	"request_channel" text NOT NULL,
	"due_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"reason_code" text,
	"result_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_case_steps" (
	"deletion_case_id" uuid NOT NULL,
	"handler" text NOT NULL,
	"state" "deletion_step_state" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"external_ref" text,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	CONSTRAINT "deletion_case_steps_deletion_case_id_handler_pk" PRIMARY KEY("deletion_case_id","handler")
);
--> statement-breakpoint
CREATE TABLE "deletion_ledger" (
	"subject_hash" text PRIMARY KEY NOT NULL,
	"hash_key_id" text NOT NULL,
	"deletion_case_id" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"minimum_backup_generation" bigint NOT NULL,
	"minimum_database_lsn" text,
	"receipt_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_ledger_outbox" (
	"deletion_case_id" uuid PRIMARY KEY NOT NULL,
	"subject_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"external_ref" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_ledger_outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "deployment_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"deployment_mode" "deployment_mode" NOT NULL,
	"registration_policy" "registration_policy" NOT NULL,
	"self_hosted_lifecycle" "self_hosted_lifecycle",
	"admin_repair_required" boolean DEFAULT false NOT NULL,
	"instance_auth_epoch" bigint DEFAULT 0 NOT NULL,
	"token_not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"auth_epoch_enforced" boolean DEFAULT false NOT NULL,
	"runtime_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"configuration_revision" bigint DEFAULT 1 NOT NULL,
	"initialized_at" timestamp with time zone,
	"initialized_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"device_id" uuid NOT NULL,
	"device_name" text NOT NULL,
	"platform" text NOT NULL,
	"encryption_public_key" text,
	"account_id" uuid,
	"status" "device_authorization_status" DEFAULT 'pending' NOT NULL,
	"approved_credential_epoch" bigint,
	"approved_instance_auth_epoch" bigint,
	"approved_issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_cursors" (
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"acknowledged_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_cursors_workspace_id_device_id_pk" PRIMARY KEY("workspace_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"account_id" uuid NOT NULL,
	"credential_epoch" bigint,
	"instance_auth_epoch" bigint,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"encryption_public_key" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source" "entitlement_grant_source" NOT NULL,
	"source_ref" text NOT NULL,
	"request_hash" text NOT NULL,
	"schema_version" integer NOT NULL,
	"entitlements" jsonb NOT NULL,
	"priority" integer NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_grants_schema_check" CHECK ("entitlement_grants"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"reason_code" text NOT NULL,
	"authority" text DEFAULT 'platform-admin' NOT NULL,
	"approved_by" uuid,
	"approved_by_staff_id" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_by_staff_id" uuid,
	"released_at" timestamp with time zone,
	"release_reason_code" text
);
--> statement-breakpoint
CREATE TABLE "mail_secret_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"payload_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_secret_payloads_version_check" CHECK ("mail_secret_payloads"."payload_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"mode" "maintenance_mode" DEFAULT 'normal' NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"reason" text,
	"entered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "object_versions" (
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"sequence" bigint NOT NULL,
	"kind" "object_kind" NOT NULL,
	"parent_object_id" uuid,
	"name_ciphertext" text,
	"name_blind_index" text,
	"ciphertext" text NOT NULL,
	"ciphertext_hash" text NOT NULL,
	"key_version" integer NOT NULL,
	"blob_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_device_id" uuid NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_versions_workspace_id_object_id_revision_pk" PRIMARY KEY("workspace_id","object_id","revision")
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"kind" "object_kind" NOT NULL,
	"parent_object_id" uuid,
	"name_ciphertext" text,
	"name_blind_index" text,
	"current_revision" bigint NOT NULL,
	"ciphertext" text NOT NULL,
	"ciphertext_hash" text NOT NULL,
	"key_version" integer NOT NULL,
	"blob_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "objects_workspace_id_object_id_pk" PRIMARY KEY("workspace_id","object_id")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"source_device_id" uuid NOT NULL,
	"request_hash" text,
	"result_revision" bigint NOT NULL,
	"result_sequence" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_workspace_id_operation_id_pk" PRIMARY KEY("workspace_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"template_or_event" text NOT NULL,
	"recipient_ref" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_version" integer NOT NULL,
	"secret_payload_ref" text,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "outbox_message_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policy_acceptances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"subject_hash" text NOT NULL,
	"subject_snapshot" jsonb NOT NULL,
	"policy_document_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_prefix_hash" text,
	"user_agent_family" text,
	"evidence_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"locale" text NOT NULL,
	"content_ref" text NOT NULL,
	"canonicalization_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"requires_reacceptance" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_instance_auth_epoch" bigint,
	"issued_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_request_id" uuid,
	"rotation_response_ciphertext" text,
	"rotation_response_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_invitation_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"account_id" uuid,
	"request_id" text NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_key_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_by_actor_type" "invitation_actor_type" NOT NULL,
	"created_by_actor_id" uuid,
	"creator_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bound_email_normalized" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"note" text,
	"replaces_invitation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_invitations_use_count_check" CHECK ("registration_invitations"."max_uses" > 0 and "registration_invitations"."use_count" >= 0 and "registration_invitations"."use_count" <= "registration_invitations"."max_uses")
);
--> statement-breakpoint
CREATE TABLE "restore_credential_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restore_marker_id" uuid NOT NULL,
	"account_id" uuid,
	"decision" text NOT NULL,
	"operator_kind" text DEFAULT 'local-operator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restore_drills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_run_id" uuid NOT NULL,
	"mode" "restore_drill_mode" NOT NULL,
	"status" text NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "restore_markers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_id" uuid NOT NULL,
	"mode" "restore_marker_mode" NOT NULL,
	"old_sync_epoch" uuid,
	"new_sync_epoch" uuid NOT NULL,
	"restored_through_sequence_by_workspace" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sanitation_status" "restore_sanitation_status" DEFAULT 'pending' NOT NULL,
	"auth_epoch_after" bigint,
	"bootstrap_token_cutoff" timestamp with time zone,
	"bootstrap_reissue_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"account_id" uuid,
	"identity_hash" text,
	"device_id" uuid,
	"ip_prefix_hash" text,
	"user_agent_family" text,
	"request_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"score" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_provider_events" (
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"signature_verified_at" timestamp with time zone NOT NULL,
	"payload_redacted" jsonb NOT NULL,
	"status" "risk_provider_event_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "risk_provider_events_provider_provider_event_id_pk" PRIMARY KEY("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "risk_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "risk_restriction_subject_type" NOT NULL,
	"subject_ref" text NOT NULL,
	"scope" "risk_restriction_scope" NOT NULL,
	"action" "risk_restriction_action" NOT NULL,
	"reason_code" text NOT NULL,
	"source" "risk_restriction_source" NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_by_staff_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_issuer" text NOT NULL,
	"external_subject" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"local_login" text,
	"local_password_hash" text,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"assigned_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"auth_strength" text NOT NULL,
	"csrf_token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_up_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_digest" text NOT NULL,
	"digest_key_id" text NOT NULL,
	"actor_type" "step_up_actor_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"action_audience" text NOT NULL,
	"auth_methods" text[] NOT NULL,
	"request_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "support_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"subject_hash" text NOT NULL,
	"account_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"category" "support_case_category" NOT NULL,
	"severity" "support_case_severity" DEFAULT 'normal' NOT NULL,
	"status" "support_case_status" DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"source" "support_case_source" NOT NULL,
	"assigned_staff_id" uuid,
	"assigned_staff_snapshot" jsonb,
	"last_message_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_diagnostic_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"account_id" uuid,
	"scope_version" text NOT NULL,
	"snapshot_ciphertext" text NOT NULL,
	"snapshot_key_id" text NOT NULL,
	"snapshot_encryption_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_diagnostic_grants_scope_check" CHECK (length("support_diagnostic_grants"."scope_version") > 0),
	CONSTRAINT "support_diagnostic_grants_encryption_version_check" CHECK ("support_diagnostic_grants"."snapshot_encryption_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"author_type" "support_message_author_type" NOT NULL,
	"author_ref" text,
	"author_snapshot" jsonb,
	"visibility" "support_message_visibility" DEFAULT 'customer' NOT NULL,
	"body_ciphertext" text NOT NULL,
	"body_key_id" text NOT NULL,
	"body_encryption_version" integer NOT NULL,
	"body_format" text DEFAULT 'plain' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_encryption_version_check" CHECK ("support_messages"."body_encryption_version" > 0),
	CONSTRAINT "support_messages_key_id_check" CHECK (length("support_messages"."body_key_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_v2_bootstrap_objects" (
	"session_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"document_id" text,
	"latest_document_sequence" bigint,
	"checkpoint_document_sequence" bigint,
	"checkpoint_id" uuid,
	"checkpoint_key_version" integer,
	"checkpoint_ciphertext" text,
	"checkpoint_ciphertext_hash" text,
	"materialized_revision" bigint,
	CONSTRAINT "sync_v2_bootstrap_objects_session_id_object_id_pk" PRIMARY KEY("session_id","object_id")
);
--> statement-breakpoint
CREATE TABLE "sync_v2_bootstrap_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"snapshot_sequence" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_v2_checkpoints" (
	"workspace_id" uuid NOT NULL,
	"checkpoint_id" uuid NOT NULL,
	"document_id" text NOT NULL,
	"object_id" uuid NOT NULL,
	"covers_document_sequence" bigint NOT NULL,
	"event_sequence" bigint NOT NULL,
	"materialized_revision" bigint,
	"key_version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"ciphertext_hash" text NOT NULL,
	"source_device_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_v2_checkpoints_workspace_id_checkpoint_id_pk" PRIMARY KEY("workspace_id","checkpoint_id")
);
--> statement-breakpoint
CREATE TABLE "sync_v2_commands" (
	"workspace_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"source_device_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_v2_commands_workspace_id_command_id_pk" PRIMARY KEY("workspace_id","command_id")
);
--> statement-breakpoint
CREATE TABLE "sync_v2_conflicts" (
	"workspace_id" uuid NOT NULL,
	"conflict_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"kind" "object_kind" NOT NULL,
	"conflict_type" text NOT NULL,
	"status" text DEFAULT 'unresolved' NOT NULL,
	"expected_revision" bigint,
	"expected_document_sequence" bigint,
	"key_version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"ciphertext_hash" text NOT NULL,
	"created_sequence" bigint NOT NULL,
	"resolved_sequence" bigint,
	"resolved_by_device_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_v2_conflicts_workspace_id_conflict_id_pk" PRIMARY KEY("workspace_id","conflict_id")
);
--> statement-breakpoint
CREATE TABLE "sync_v2_documents" (
	"workspace_id" uuid NOT NULL,
	"document_id" text NOT NULL,
	"object_id" uuid NOT NULL,
	"kind" "object_kind" NOT NULL,
	"latest_document_sequence" bigint DEFAULT 0 NOT NULL,
	"checkpoint_document_sequence" bigint DEFAULT 0 NOT NULL,
	"checkpoint_id" uuid,
	"checkpoint_key_version" integer,
	"checkpoint_ciphertext" text,
	"checkpoint_ciphertext_hash" text,
	"materialized_revision" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_v2_documents_workspace_id_document_id_pk" PRIMARY KEY("workspace_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "sync_v2_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"source_device_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"object_id" uuid,
	"document_id" text,
	"document_sequence" bigint,
	"key_version" integer,
	"ciphertext" text,
	"ciphertext_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_v2_resource_bindings" (
	"workspace_id" uuid NOT NULL,
	"owner_object_id" uuid NOT NULL,
	"owner_revision" bigint NOT NULL,
	"resource_object_id" uuid NOT NULL,
	"resource_revision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_v2_resource_bindings_workspace_id_owner_object_id_owner_revision_resource_object_id_pk" PRIMARY KEY("workspace_id","owner_object_id","owner_revision","resource_object_id")
);
--> statement-breakpoint
CREATE TABLE "sync_v2_updates" (
	"workspace_id" uuid NOT NULL,
	"document_id" text NOT NULL,
	"document_sequence" bigint NOT NULL,
	"update_id" uuid NOT NULL,
	"event_sequence" bigint NOT NULL,
	"source_device_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"ciphertext_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_v2_updates_workspace_id_document_id_document_sequence_pk" PRIMARY KEY("workspace_id","document_id","document_sequence")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"workspace_id" uuid,
	"metric" text NOT NULL,
	"delta" bigint NOT NULL,
	"resulting_value" bigint,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"billing_period" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"workspace_id" uuid,
	"metric" text NOT NULL,
	"quantity" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"provider_upload_ref" text,
	"status" "usage_reservation_status" DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_instance_auth_epoch" bigint,
	"issued_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_key_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"envelope_type" "key_envelope_type" NOT NULL,
	"recipient_id" text,
	"wrapped_key" text NOT NULL,
	"kdf_salt" text,
	"kdf_params" jsonb,
	"status" "key_envelope_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"replacement_idempotency_key" text,
	"replacement_request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_keys" (
	"workspace_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_keys_workspace_id_key_version_pk" PRIMARY KEY("workspace_id","key_version")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name_ciphertext" text NOT NULL,
	"creation_idempotency_key" text,
	"creation_request_hash" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"latest_sequence" bigint DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_action_tokens" ADD CONSTRAINT "account_action_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_tokens" ADD CONSTRAINT "account_action_tokens_identity_id_account_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."account_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identities" ADD CONSTRAINT "account_identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_login_claim_conflicts" ADD CONSTRAINT "account_login_claim_conflicts_candidate_account_id_accounts_id_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_login_claim_conflicts" ADD CONSTRAINT "account_login_claim_conflicts_candidate_identity_id_account_identities_id_fk" FOREIGN KEY ("candidate_identity_id") REFERENCES "public"."account_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_login_claims" ADD CONSTRAINT "account_login_claims_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_login_claims" ADD CONSTRAINT "account_login_claims_identity_id_account_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."account_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD CONSTRAINT "account_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD CONSTRAINT "account_subscriptions_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."billing_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_backups" ADD CONSTRAINT "admin_backups_job_id_admin_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."admin_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_jobs" ADD CONSTRAINT "admin_jobs_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_test_objects" ADD CONSTRAINT "admin_test_objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_test_objects" ADD CONSTRAINT "admin_test_objects_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_target_account_id_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_artifacts" ADD CONSTRAINT "backup_artifacts_backup_run_id_backup_runs_id_fk" FOREIGN KEY ("backup_run_id") REFERENCES "public"."backup_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_policy_id_backup_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backup_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_account_states" ADD CONSTRAINT "billing_account_states_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_account_states" ADD CONSTRAINT "billing_account_states_current_subscription_id_account_subscriptions_id_fk" FOREIGN KEY ("current_subscription_id") REFERENCES "public"."account_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_account_states" ADD CONSTRAINT "billing_account_states_purchase_intent_id_billing_checkout_sessions_id_fk" FOREIGN KEY ("purchase_intent_id") REFERENCES "public"."billing_checkout_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_subscription_id_account_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."account_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_price_mapping_id_billing_price_mappings_id_fk" FOREIGN KEY ("price_mapping_id") REFERENCES "public"."billing_price_mappings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."billing_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_price_mappings" ADD CONSTRAINT "billing_price_mappings_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."billing_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_upload_parts" ADD CONSTRAINT "blob_upload_parts_upload_id_blob_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."blob_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_uploads" ADD CONSTRAINT "blob_uploads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_uploads" ADD CONSTRAINT "blob_uploads_usage_reservation_id_usage_reservations_id_fk" FOREIGN KEY ("usage_reservation_id") REFERENCES "public"."usage_reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_sessions" ADD CONSTRAINT "bootstrap_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_sessions" ADD CONSTRAINT "bootstrap_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_case_steps" ADD CONSTRAINT "deletion_case_steps_deletion_case_id_account_deletion_cases_id_fk" FOREIGN KEY ("deletion_case_id") REFERENCES "public"."account_deletion_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_ledger_outbox" ADD CONSTRAINT "deletion_ledger_outbox_deletion_case_id_account_deletion_cases_id_fk" FOREIGN KEY ("deletion_case_id") REFERENCES "public"."account_deletion_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_cursors" ADD CONSTRAINT "device_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_cursors" ADD CONSTRAINT "device_cursors_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_approved_by_accounts_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_approved_by_staff_id_staff_principals_id_fk" FOREIGN KEY ("approved_by_staff_id") REFERENCES "public"."staff_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_accounts_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_staff_id_staff_principals_id_fk" FOREIGN KEY ("released_by_staff_id") REFERENCES "public"."staff_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_versions" ADD CONSTRAINT "object_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_versions" ADD CONSTRAINT "object_versions_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_versions" ADD CONSTRAINT "object_versions_workspace_key_fk" FOREIGN KEY ("workspace_id","key_version") REFERENCES "public"."workspace_keys"("workspace_id","key_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_workspace_key_fk" FOREIGN KEY ("workspace_id","key_version") REFERENCES "public"."workspace_keys"("workspace_id","key_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD CONSTRAINT "policy_acceptances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD CONSTRAINT "policy_acceptances_policy_document_id_policy_documents_id_fk" FOREIGN KEY ("policy_document_id") REFERENCES "public"."policy_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_invitation_uses" ADD CONSTRAINT "registration_invitation_uses_invitation_id_registration_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."registration_invitations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_invitation_uses" ADD CONSTRAINT "registration_invitation_uses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_credential_reviews" ADD CONSTRAINT "restore_credential_reviews_restore_marker_id_restore_markers_id_fk" FOREIGN KEY ("restore_marker_id") REFERENCES "public"."restore_markers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_credential_reviews" ADD CONSTRAINT "restore_credential_reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_drills" ADD CONSTRAINT "restore_drills_backup_run_id_backup_runs_id_fk" FOREIGN KEY ("backup_run_id") REFERENCES "public"."backup_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_restrictions" ADD CONSTRAINT "risk_restrictions_created_by_staff_id_staff_principals_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_restrictions" ADD CONSTRAINT "risk_restrictions_revoked_by_staff_id_staff_principals_id_fk" FOREIGN KEY ("revoked_by_staff_id") REFERENCES "public"."staff_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_staff_id_staff_principals_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_assigned_by_staff_id_staff_principals_id_fk" FOREIGN KEY ("assigned_by_staff_id") REFERENCES "public"."staff_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_staff_principals_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_assigned_staff_id_staff_principals_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_diagnostic_grants" ADD CONSTRAINT "support_diagnostic_grants_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_diagnostic_grants" ADD CONSTRAINT "support_diagnostic_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_bootstrap_objects" ADD CONSTRAINT "sync_v2_bootstrap_objects_session_id_sync_v2_bootstrap_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sync_v2_bootstrap_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_bootstrap_objects" ADD CONSTRAINT "sync_v2_bootstrap_objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_bootstrap_sessions" ADD CONSTRAINT "sync_v2_bootstrap_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_checkpoints" ADD CONSTRAINT "sync_v2_checkpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_checkpoints" ADD CONSTRAINT "sync_v2_checkpoints_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_commands" ADD CONSTRAINT "sync_v2_commands_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_commands" ADD CONSTRAINT "sync_v2_commands_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_conflicts" ADD CONSTRAINT "sync_v2_conflicts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_conflicts" ADD CONSTRAINT "sync_v2_conflicts_resolved_by_device_id_devices_id_fk" FOREIGN KEY ("resolved_by_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_documents" ADD CONSTRAINT "sync_v2_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_events" ADD CONSTRAINT "sync_v2_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_events" ADD CONSTRAINT "sync_v2_events_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_resource_bindings" ADD CONSTRAINT "sync_v2_resource_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_resource_bindings" ADD CONSTRAINT "sync_v2_resource_bindings_owner_version_fk" FOREIGN KEY ("workspace_id","owner_object_id","owner_revision") REFERENCES "public"."object_versions"("workspace_id","object_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_resource_bindings" ADD CONSTRAINT "sync_v2_resource_bindings_resource_version_fk" FOREIGN KEY ("workspace_id","resource_object_id","resource_revision") REFERENCES "public"."object_versions"("workspace_id","object_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_updates" ADD CONSTRAINT "sync_v2_updates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_v2_updates" ADD CONSTRAINT "sync_v2_updates_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_key_envelopes" ADD CONSTRAINT "workspace_key_envelopes_key_fk" FOREIGN KEY ("workspace_id","key_version") REFERENCES "public"."workspace_keys"("workspace_id","key_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_action_tokens_hash_unique" ON "account_action_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_action_tokens_account_idx" ON "account_action_tokens" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_cases_active_account_unique" ON "account_deletion_cases" USING btree ("account_id") WHERE "account_deletion_cases"."account_id" is not null and "account_deletion_cases"."status" in ('requested', 'cooling_off', 'scheduled', 'held', 'purging');--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_cases_active_subject_unique" ON "account_deletion_cases" USING btree ("subject_hash") WHERE "account_deletion_cases"."status" in ('requested', 'cooling_off', 'scheduled', 'held', 'purging');--> statement-breakpoint
CREATE UNIQUE INDEX "account_identities_active_unique" ON "account_identities" USING btree ("kind","normalized_identifier") WHERE "account_identities"."disabled_at" is null;--> statement-breakpoint
CREATE INDEX "account_identities_account_idx" ON "account_identities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_login_claim_conflicts_status_idx" ON "account_login_claim_conflicts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "account_service_audit_events_actor_idx" ON "account_service_audit_events" USING btree ("actor_type","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "account_service_audit_events_target_idx" ON "account_service_audit_events" USING btree ("target_type","target_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_subscriptions_provider_subscription_unique" ON "account_subscriptions" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_subscriptions_current_account_unique" ON "account_subscriptions" USING btree ("account_id") WHERE "account_subscriptions"."account_id" is not null and "account_subscriptions"."is_current";--> statement-breakpoint
CREATE INDEX "account_subscriptions_account_status_idx" ON "account_subscriptions" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_login_unique" ON "accounts" USING btree (lower("login"));--> statement-breakpoint
CREATE INDEX "accounts_login_trgm_idx" ON "accounts" USING gin ("login" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "devices_name_trgm_idx" ON "devices" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "admin_audit_logs_actor_idx" ON "admin_audit_logs" USING btree ("actor_account_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_created_idx" ON "admin_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_backups_filename_unique" ON "admin_backups" USING btree ("filename");--> statement-breakpoint
CREATE INDEX "admin_jobs_created_idx" ON "admin_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_jobs_status_idx" ON "admin_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "admin_test_objects_created_idx" ON "admin_test_objects" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_idempotency_unique" ON "background_jobs" USING btree ("type","idempotency_key");--> statement-breakpoint
CREATE INDEX "background_jobs_claim_idx" ON "background_jobs" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_artifacts_run_path_unique" ON "backup_artifacts" USING btree ("backup_run_id","relative_path");--> statement-breakpoint
CREATE INDEX "backup_artifacts_run_idx" ON "backup_artifacts" USING btree ("backup_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_runs_generation_unique" ON "backup_runs" USING btree ("generation");--> statement-breakpoint
CREATE INDEX "backup_runs_status_idx" ON "backup_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_sessions_account_idempotency_unique" ON "billing_checkout_sessions" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_sessions_provider_checkout_unique" ON "billing_checkout_sessions" USING btree ("provider","provider_checkout_id") WHERE "billing_checkout_sessions"."provider_checkout_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_sessions_active_account_unique" ON "billing_checkout_sessions" USING btree ("account_id") WHERE "billing_checkout_sessions"."status" in ('pending_provider','open','completed','reconciling');--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_provider_customer_unique" ON "billing_customers" USING btree ("provider","provider_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_account_unique" ON "billing_customers" USING btree ("account_id") WHERE "billing_customers"."account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_versions_key_version_unique" ON "billing_plan_versions" USING btree ("plan_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_price_mappings_provider_price_unique" ON "billing_price_mappings" USING btree ("provider","provider_environment","provider_price_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_price_mappings_plan_provider_unique" ON "billing_price_mappings" USING btree ("plan_version_id","provider","provider_environment","currency","interval");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_claim_idx" ON "billing_webhook_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blob_uploads_workspace_blob_unique" ON "blob_uploads" USING btree ("workspace_id","blob_id");--> statement-breakpoint
CREATE INDEX "blob_uploads_workspace_blob_idx" ON "blob_uploads" USING btree ("workspace_id","blob_id");--> statement-breakpoint
CREATE INDEX "blob_uploads_expiry_idx" ON "blob_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blob_uploads_usage_reservation_unique" ON "blob_uploads" USING btree ("usage_reservation_id") WHERE "blob_uploads"."usage_reservation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "blobs_storage_key_unique" ON "blobs" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "blobs_gc_idx" ON "blobs" USING btree ("state","last_referenced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_credentials_token_hash_unique" ON "bootstrap_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "bootstrap_credentials_active_idx" ON "bootstrap_credentials" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "bootstrap_sessions_expiry_idx" ON "bootstrap_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "bootstrap_sessions_device_idx" ON "bootstrap_sessions" USING btree ("workspace_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "changes_workspace_sequence_unique" ON "changes" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "changes_workspace_object_idx" ON "changes" USING btree ("workspace_id","object_id");--> statement-breakpoint
CREATE INDEX "changes_created_idx" ON "changes" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_requests_subject_idempotency_unique" ON "data_requests" USING btree ("subject_hash","client_idempotency_key");--> statement-breakpoint
CREATE INDEX "data_requests_status_idx" ON "data_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "deletion_ledger_outbox_claim_idx" ON "deletion_ledger_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_device_code_unique" ON "device_authorizations" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_user_code_unique" ON "device_authorizations" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "device_authorizations_expiry_idx" ON "device_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_authorizations_account_idx" ON "device_authorizations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_pairings_token_hash_unique" ON "device_pairings" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "device_pairings_account_idx" ON "device_pairings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "device_pairings_expiry_idx" ON "device_pairings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "devices_account_idx" ON "devices" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_source_unique" ON "entitlement_grants" USING btree ("account_id","source","source_ref");--> statement-breakpoint
CREATE INDEX "entitlement_grants_active_idx" ON "entitlement_grants" USING btree ("account_id","starts_at","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_holds_active_account_unique" ON "legal_holds" USING btree ("account_id") WHERE "legal_holds"."released_at" is null;--> statement-breakpoint
CREATE INDEX "legal_holds_account_idx" ON "legal_holds" USING btree ("account_id","approved_at");--> statement-breakpoint
CREATE INDEX "mail_secret_payloads_expiry_idx" ON "mail_secret_payloads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "object_versions_created_idx" ON "object_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "object_versions_sequence_idx" ON "object_versions" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "objects_workspace_kind_idx" ON "objects" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "objects_workspace_updated_idx" ON "objects" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "objects_sibling_name_blind_idx" ON "objects" USING btree ("workspace_id","parent_object_id","name_blind_index") WHERE "objects"."deleted_at" is null and "objects"."name_blind_index" is not null;--> statement-breakpoint
CREATE INDEX "operations_created_idx" ON "operations" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_messages_idempotency_unique" ON "outbox_messages" USING btree ("channel","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_messages_claim_idx" ON "outbox_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "policy_acceptances_subject_idx" ON "policy_acceptances" USING btree ("subject_hash","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_documents_version_locale_unique" ON "policy_documents" USING btree ("type","version","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_unique" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_device_idx" ON "refresh_tokens" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitation_uses_account_unique" ON "registration_invitation_uses" USING btree ("invitation_id","account_id");--> statement-breakpoint
CREATE INDEX "registration_invitation_uses_invitation_idx" ON "registration_invitation_uses" USING btree ("invitation_id","used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_token_hash_unique" ON "registration_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "registration_invitations_active_idx" ON "registration_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "restore_credential_reviews_marker_account_unique" ON "restore_credential_reviews" USING btree ("restore_marker_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "restore_markers_new_epoch_unique" ON "restore_markers" USING btree ("new_sync_epoch");--> statement-breakpoint
CREATE INDEX "risk_events_account_created_idx" ON "risk_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "risk_events_event_created_idx" ON "risk_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "risk_provider_events_claim_idx" ON "risk_provider_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_restrictions_active_unique" ON "risk_restrictions" USING btree ("subject_type","subject_ref","scope","action") WHERE "risk_restrictions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "risk_restrictions_subject_idx" ON "risk_restrictions" USING btree ("subject_type","subject_ref","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_principals_issuer_subject_unique" ON "staff_principals" USING btree ("external_issuer","external_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_principals_local_login_unique" ON "staff_principals" USING btree ("local_login") WHERE "staff_principals"."local_login" is not null;--> statement-breakpoint
CREATE INDEX "staff_principals_active_idx" ON "staff_principals" USING btree ("disabled_at");--> statement-breakpoint
CREATE INDEX "staff_role_assignments_staff_role_idx" ON "staff_role_assignments" USING btree ("staff_id","role_key");--> statement-breakpoint
CREATE INDEX "staff_role_assignments_active_idx" ON "staff_role_assignments" USING btree ("staff_id","expires_at");--> statement-breakpoint
CREATE INDEX "staff_sessions_active_idx" ON "staff_sessions" USING btree ("staff_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "step_up_grants_token_digest_unique" ON "step_up_grants" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "step_up_grants_actor_session_expiry_idx" ON "step_up_grants" USING btree ("actor_id","session_id","expires_at");--> statement-breakpoint
CREATE INDEX "support_cases_account_updated_idx" ON "support_cases" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "support_cases_queue_idx" ON "support_cases" USING btree ("status","last_message_at");--> statement-breakpoint
CREATE INDEX "support_diagnostic_grants_case_idx" ON "support_diagnostic_grants" USING btree ("case_id","expires_at");--> statement-breakpoint
CREATE INDEX "support_diagnostic_grants_account_idx" ON "support_diagnostic_grants" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_case_author_idempotency_unique" ON "support_messages" USING btree ("case_id","author_type","idempotency_key");--> statement-breakpoint
CREATE INDEX "support_messages_case_created_idx" ON "support_messages" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_v2_bootstrap_objects_workspace_idx" ON "sync_v2_bootstrap_objects" USING btree ("workspace_id","session_id","object_id");--> statement-breakpoint
CREATE INDEX "sync_v2_bootstrap_sessions_workspace_idx" ON "sync_v2_bootstrap_sessions" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "sync_v2_checkpoints_document_idx" ON "sync_v2_checkpoints" USING btree ("workspace_id","document_id","event_sequence");--> statement-breakpoint
CREATE INDEX "sync_v2_commands_created_idx" ON "sync_v2_commands" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_v2_conflicts_status_idx" ON "sync_v2_conflicts" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sync_v2_conflicts_object_idx" ON "sync_v2_conflicts" USING btree ("workspace_id","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_v2_documents_object_unique" ON "sync_v2_documents" USING btree ("workspace_id","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_v2_events_workspace_sequence_unique" ON "sync_v2_events" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_v2_events_workspace_event_unique" ON "sync_v2_events" USING btree ("workspace_id","event_id");--> statement-breakpoint
CREATE INDEX "sync_v2_events_document_idx" ON "sync_v2_events" USING btree ("workspace_id","document_id","document_sequence");--> statement-breakpoint
CREATE INDEX "sync_v2_events_created_idx" ON "sync_v2_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_v2_resource_bindings_resource_idx" ON "sync_v2_resource_bindings" USING btree ("workspace_id","resource_object_id","resource_revision");--> statement-breakpoint
CREATE INDEX "sync_v2_resource_bindings_owner_idx" ON "sync_v2_resource_bindings" USING btree ("workspace_id","owner_object_id","owner_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_v2_updates_id_unique" ON "sync_v2_updates" USING btree ("workspace_id","update_id");--> statement-breakpoint
CREATE INDEX "sync_v2_updates_event_idx" ON "sync_v2_updates" USING btree ("workspace_id","event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_workspace_idempotency_unique" ON "usage_events" USING btree ("account_id","workspace_id","idempotency_key") WHERE "usage_events"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_account_idempotency_unique" ON "usage_events" USING btree ("account_id","idempotency_key") WHERE "usage_events"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "usage_events_account_occurred_idx" ON "usage_events" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reservations_workspace_source_unique" ON "usage_reservations" USING btree ("account_id","workspace_id","source_type","source_id","metric") WHERE "usage_reservations"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reservations_account_source_unique" ON "usage_reservations" USING btree ("account_id","source_type","source_id","metric") WHERE "usage_reservations"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "usage_reservations_expiry_idx" ON "usage_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_token_hash_unique" ON "web_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "web_sessions_account_idx" ON "web_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "web_sessions_expiry_idx" ON "web_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workspace_key_envelopes_key_idx" ON "workspace_key_envelopes" USING btree ("workspace_id","key_version");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_key_envelopes_active_recipient_unique" ON "workspace_key_envelopes" USING btree ("workspace_id","key_version","envelope_type",coalesce("recipient_id", '')) WHERE "workspace_key_envelopes"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_key_envelopes_replacement_idempotency_unique" ON "workspace_key_envelopes" USING btree ("workspace_id","key_version","replacement_idempotency_key") WHERE "workspace_key_envelopes"."replacement_idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "workspaces_account_idx" ON "workspaces" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_active_default_unique" ON "workspaces" USING btree ("account_id") WHERE "workspaces"."is_default" = true and "workspaces"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_account_creation_idempotency_unique" ON "workspaces" USING btree ("account_id","creation_idempotency_key") WHERE "workspaces"."creation_idempotency_key" is not null;
