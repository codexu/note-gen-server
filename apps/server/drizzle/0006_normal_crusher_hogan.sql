CREATE TABLE "bootstrap_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"snapshot_sequence" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "object_versions" ADD COLUMN "sequence" bigint;--> statement-breakpoint
UPDATE "object_versions" AS v
SET "sequence" = c."sequence"
FROM "changes" AS c
WHERE c."workspace_id" = v."workspace_id"
	AND c."object_id" = v."object_id"
	AND c."revision" = v."revision";--> statement-breakpoint
UPDATE "object_versions" SET "sequence" = 0 WHERE "sequence" IS NULL;--> statement-breakpoint
ALTER TABLE "object_versions" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bootstrap_sessions" ADD CONSTRAINT "bootstrap_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_sessions" ADD CONSTRAINT "bootstrap_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bootstrap_sessions_expiry_idx" ON "bootstrap_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "bootstrap_sessions_device_idx" ON "bootstrap_sessions" USING btree ("workspace_id","device_id");--> statement-breakpoint
CREATE INDEX "object_versions_sequence_idx" ON "object_versions" USING btree ("workspace_id","sequence");
