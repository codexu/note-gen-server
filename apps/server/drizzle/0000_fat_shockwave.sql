CREATE TYPE "public"."blob_state" AS ENUM('uploading', 'ready', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."change_type" AS ENUM('upsert', 'delete');--> statement-breakpoint
CREATE TYPE "public"."object_kind" AS ENUM('note', 'folder', 'asset', 'canvas', 'record', 'tag', 'mark', 'conversation', 'memory', 'setting', 'yjs-checkpoint', 'yjs-update');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"blob_id" text NOT NULL,
	"expected_size" bigint NOT NULL,
	"received_size" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
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
CREATE TABLE "device_cursors" (
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"acknowledged_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_cursors_workspace_id_device_id_pk" PRIMARY KEY("workspace_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "object_versions" (
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"kind" "object_kind" NOT NULL,
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
	"result_revision" bigint NOT NULL,
	"result_sequence" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_workspace_id_operation_id_pk" PRIMARY KEY("workspace_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_keys" (
	"workspace_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"wrapped_key" text NOT NULL,
	"kdf_salt" text NOT NULL,
	"kdf_params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_keys_workspace_id_key_version_pk" PRIMARY KEY("workspace_id","key_version")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name_ciphertext" text NOT NULL,
	"latest_sequence" bigint DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blob_uploads" ADD CONSTRAINT "blob_uploads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_cursors" ADD CONSTRAINT "device_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_cursors" ADD CONSTRAINT "device_cursors_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_versions" ADD CONSTRAINT "object_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_versions" ADD CONSTRAINT "object_versions_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_login_unique" ON "accounts" USING btree (lower("login"));--> statement-breakpoint
CREATE INDEX "blob_uploads_workspace_blob_idx" ON "blob_uploads" USING btree ("workspace_id","blob_id");--> statement-breakpoint
CREATE INDEX "blob_uploads_expiry_idx" ON "blob_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blobs_storage_key_unique" ON "blobs" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "blobs_gc_idx" ON "blobs" USING btree ("state","last_referenced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "changes_workspace_sequence_unique" ON "changes" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "changes_workspace_object_idx" ON "changes" USING btree ("workspace_id","object_id");--> statement-breakpoint
CREATE INDEX "changes_created_idx" ON "changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "devices_account_idx" ON "devices" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "object_versions_created_idx" ON "object_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "objects_workspace_kind_idx" ON "objects" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "objects_workspace_updated_idx" ON "objects" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "operations_created_idx" ON "operations" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_unique" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_device_idx" ON "refresh_tokens" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "workspaces_account_idx" ON "workspaces" USING btree ("account_id");