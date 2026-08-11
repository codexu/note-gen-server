CREATE TABLE "account_service_audit_events" (
  "id" bigserial PRIMARY KEY,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "request_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "account_service_audit_events_actor_type_check" CHECK ("actor_type" IN ('account', 'staff', 'system', 'webhook')),
  CONSTRAINT "account_service_audit_events_action_check" CHECK (length("action") > 0),
  CONSTRAINT "account_service_audit_events_target_type_check" CHECK (length("target_type") > 0)
);
--> statement-breakpoint
CREATE INDEX "account_service_audit_events_actor_idx" ON "account_service_audit_events" ("actor_type", "actor_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "account_service_audit_events_target_idx" ON "account_service_audit_events" ("target_type", "target_id", "occurred_at");
