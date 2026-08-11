ALTER TABLE "deployment_settings" ADD COLUMN "instance_auth_epoch" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "token_not_before" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "auth_epoch_enforced" boolean DEFAULT false NOT NULL;
