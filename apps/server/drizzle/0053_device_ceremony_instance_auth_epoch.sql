ALTER TABLE "device_authorizations" ADD COLUMN "approved_instance_auth_epoch" bigint;
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "approved_issued_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "device_pairings" ADD COLUMN "instance_auth_epoch" bigint;
--> statement-breakpoint
ALTER TABLE "device_pairings" ADD COLUMN "issued_at" timestamp with time zone;
