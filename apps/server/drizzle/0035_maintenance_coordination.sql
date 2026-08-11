CREATE TYPE "maintenance_mode" AS ENUM ('normal', 'read_only', 'write_drain', 'offline');
--> statement-breakpoint
CREATE TABLE "maintenance_state" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "mode" "maintenance_mode" DEFAULT 'normal' NOT NULL,
  "generation" bigint DEFAULT 0 NOT NULL,
  "reason" text,
  "entered_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maintenance_state_singleton" CHECK ("id" = true),
  CONSTRAINT "maintenance_state_generation_nonnegative" CHECK ("generation" >= 0),
  CONSTRAINT "maintenance_state_reason_required" CHECK (("mode" = 'normal' AND "reason" IS NULL) OR ("mode" <> 'normal' AND length(trim("reason")) > 0))
);
--> statement-breakpoint
INSERT INTO "maintenance_state" ("id", "mode", "generation") VALUES (true, 'normal', 0) ON CONFLICT ("id") DO NOTHING;
