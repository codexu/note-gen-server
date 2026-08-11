ALTER TABLE "staff_principals" ADD COLUMN "local_login" text;
--> statement-breakpoint
ALTER TABLE "staff_principals" ADD COLUMN "local_password_hash" text;
--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD COLUMN "csrf_token_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_principals_local_login_unique" ON "staff_principals" USING btree ("local_login") WHERE "local_login" is not null;
