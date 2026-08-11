CREATE TABLE "staff_principals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_issuer" text NOT NULL,
  "external_subject" text NOT NULL,
  "display_name" text NOT NULL,
  "email" text,
  "disabled_at" timestamp with time zone,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_principals_issuer_subject_unique" ON "staff_principals" ("external_issuer", "external_subject");
--> statement-breakpoint
CREATE INDEX "staff_principals_active_idx" ON "staff_principals" ("disabled_at");
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid NOT NULL REFERENCES "staff_principals"("id") ON DELETE CASCADE,
  "auth_strength" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "staff_sessions_active_idx" ON "staff_sessions" ("staff_id", "expires_at");
--> statement-breakpoint
CREATE TABLE "staff_role_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid NOT NULL REFERENCES "staff_principals"("id") ON DELETE CASCADE,
  "role_key" text NOT NULL,
  "scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "assigned_by_staff_id" uuid REFERENCES "staff_principals"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "staff_role_assignments_staff_role_idx" ON "staff_role_assignments" ("staff_id", "role_key");
--> statement-breakpoint
CREATE INDEX "staff_role_assignments_active_idx" ON "staff_role_assignments" ("staff_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "support_cases" DROP CONSTRAINT IF EXISTS "support_cases_assigned_staff_id_accounts_id_fk";
--> statement-breakpoint
UPDATE "support_cases" SET "assigned_staff_id" = NULL WHERE "assigned_staff_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_assigned_staff_id_staff_principals_id_fk"
  FOREIGN KEY ("assigned_staff_id") REFERENCES "staff_principals"("id") ON DELETE SET NULL;
