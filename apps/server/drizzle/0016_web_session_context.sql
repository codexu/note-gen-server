ALTER TABLE "web_sessions" ADD COLUMN IF NOT EXISTS "last_ip" text;
ALTER TABLE "web_sessions" ADD COLUMN IF NOT EXISTS "user_agent" text;
