CREATE TYPE "step_up_actor_type" AS ENUM ('account', 'staff');
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
CREATE UNIQUE INDEX "step_up_grants_token_digest_unique" ON "step_up_grants" ("token_digest");
--> statement-breakpoint
CREATE INDEX "step_up_grants_actor_session_expiry_idx" ON "step_up_grants" ("actor_id", "session_id", "expires_at");
