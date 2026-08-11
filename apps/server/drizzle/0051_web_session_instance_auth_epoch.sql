ALTER TABLE "web_sessions" ADD COLUMN "issued_instance_auth_epoch" bigint;
--> statement-breakpoint
ALTER TABLE "web_sessions" ADD COLUMN "issued_at" timestamp with time zone;
