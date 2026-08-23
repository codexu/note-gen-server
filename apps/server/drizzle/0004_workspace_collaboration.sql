CREATE TYPE "public"."workspace_type" AS ENUM('account-data', 'library');
CREATE TYPE "public"."workspace_member_role" AS ENUM('viewer', 'editor', 'manager');
CREATE TYPE "public"."workspace_invitation_kind" AS ENUM('account', 'link');
CREATE TYPE "public"."workspace_invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');
ALTER TYPE "public"."object_kind" ADD VALUE 'message';

ALTER TABLE "workspaces" ADD COLUMN "workspace_type" "workspace_type" DEFAULT 'library' NOT NULL;
UPDATE "workspaces" SET "workspace_type" = 'account-data' WHERE "is_default" = true;

CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "workspace_member_role" NOT NULL,
	"capabilities" text[] NOT NULL,
	"invited_by_account_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_account_id_pk" PRIMARY KEY("workspace_id","account_id")
);

CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "workspace_invitation_kind" NOT NULL,
	"invitee_account_id" uuid,
	"token_hash" text,
	"token_hint" text,
	"role" "workspace_member_role" NOT NULL,
	"capabilities" text[] NOT NULL,
	"status" "workspace_invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by_account_id" uuid NOT NULL,
	"accepted_by_account_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade;
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_account_id_accounts_id_fk" FOREIGN KEY ("invited_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invitee_account_id_accounts_id_fk" FOREIGN KEY ("invitee_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_account_id_accounts_id_fk" FOREIGN KEY ("invited_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict;
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_account_id_accounts_id_fk" FOREIGN KEY ("accepted_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null;

CREATE INDEX "workspace_members_account_idx" ON "workspace_members" USING btree ("account_id","updated_at");
CREATE INDEX "workspace_invitations_workspace_idx" ON "workspace_invitations" USING btree ("workspace_id","status","created_at");
CREATE INDEX "workspace_invitations_invitee_idx" ON "workspace_invitations" USING btree ("invitee_account_id","status","created_at");
CREATE UNIQUE INDEX "workspace_invitations_token_unique" ON "workspace_invitations" USING btree ("token_hash") WHERE "token_hash" is not null;
CREATE UNIQUE INDEX "workspace_invitations_pending_account_unique" ON "workspace_invitations" USING btree ("workspace_id","invitee_account_id") WHERE "kind" = 'account' and "status" = 'pending';
CREATE UNIQUE INDEX "workspaces_account_data_unique" ON "workspaces" USING btree ("account_id") WHERE "workspace_type" = 'account-data' and "deleted_at" is null;
