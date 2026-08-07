CREATE TABLE "blob_upload_parts" (
	"upload_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"size" bigint NOT NULL,
	"etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_upload_parts_upload_id_part_number_pk" PRIMARY KEY("upload_id","part_number")
);
--> statement-breakpoint
ALTER TABLE "blob_uploads" ADD COLUMN "storage_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "blob_uploads" ADD COLUMN "provider_upload_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "blob_upload_parts" ADD CONSTRAINT "blob_upload_parts_upload_id_blob_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."blob_uploads"("id") ON DELETE cascade ON UPDATE no action;