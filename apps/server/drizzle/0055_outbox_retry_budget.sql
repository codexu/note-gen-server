ALTER TABLE "outbox_messages" ADD COLUMN "max_attempts" integer DEFAULT 10 NOT NULL;
--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_max_attempts_check" CHECK ("max_attempts" > 0);
