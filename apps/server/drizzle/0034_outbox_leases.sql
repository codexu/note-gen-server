ALTER TABLE "outbox_messages" ADD COLUMN "locked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "locked_by" text;
--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "outbox_messages_lease_idx" ON "outbox_messages" ("status","lease_expires_at");
