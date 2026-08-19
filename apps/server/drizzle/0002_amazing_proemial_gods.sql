CREATE TABLE "sync_device_cursors" (
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"acknowledged_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_device_cursors_workspace_id_device_id_pk" PRIMARY KEY("workspace_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "sync_commands" ADD COLUMN "sync_epoch" uuid;--> statement-breakpoint
ALTER TABLE "sync_device_cursors" ADD CONSTRAINT "sync_device_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_device_cursors" ADD CONSTRAINT "sync_device_cursors_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_device_cursors_updated_idx" ON "sync_device_cursors" USING btree ("workspace_id","updated_at");