ALTER TABLE "refresh_tokens" ADD COLUMN "issued_instance_auth_epoch" bigint;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "issued_at" timestamp with time zone;
