CREATE TABLE "server_metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "encryption_public_key" text;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "request_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "blob_uploads_workspace_blob_unique" ON "blob_uploads" USING btree ("workspace_id","blob_id");