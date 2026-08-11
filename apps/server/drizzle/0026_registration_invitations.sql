CREATE TYPE "invitation_actor_type" AS ENUM ('account', 'staff', 'system');
--> statement-breakpoint
CREATE TABLE "registration_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_key_id" text NOT NULL, "token_hash" text NOT NULL, "token_hint" text NOT NULL,
  "created_by_actor_type" "invitation_actor_type" NOT NULL, "created_by_actor_id" uuid,
  "creator_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL, "bound_email_normalized" text,
  "max_uses" integer DEFAULT 1 NOT NULL, "use_count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL, "revoked_at" timestamp with time zone,
  "last_sent_at" timestamp with time zone, "note" text, "replaces_invitation_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "registration_invitations_use_count_check" CHECK ("max_uses" > 0 AND "use_count" >= 0 AND "use_count" <= "max_uses")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_token_hash_unique" ON "registration_invitations" ("token_hash");
--> statement-breakpoint
CREATE INDEX "registration_invitations_active_idx" ON "registration_invitations" ("expires_at");
--> statement-breakpoint
CREATE TABLE "registration_invitation_uses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "invitation_id" uuid NOT NULL REFERENCES "registration_invitations"("id") ON DELETE RESTRICT,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "request_id" text NOT NULL, "used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitation_uses_account_unique" ON "registration_invitation_uses" ("invitation_id", "account_id");
--> statement-breakpoint
CREATE INDEX "registration_invitation_uses_invitation_idx" ON "registration_invitation_uses" ("invitation_id", "used_at");
