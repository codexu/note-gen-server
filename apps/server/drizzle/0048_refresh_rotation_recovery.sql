ALTER TABLE "refresh_tokens" ADD COLUMN "rotation_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "rotation_response_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "rotation_response_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "refresh_tokens_rotation_recovery_idx" ON "refresh_tokens" ("rotation_request_id", "rotation_response_expires_at");
