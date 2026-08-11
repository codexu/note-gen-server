ALTER TABLE "blob_uploads" ADD COLUMN "usage_reservation_id" uuid;
--> statement-breakpoint
ALTER TABLE "blob_uploads" ADD CONSTRAINT "blob_uploads_usage_reservation_id_usage_reservations_id_fk" FOREIGN KEY ("usage_reservation_id") REFERENCES "usage_reservations"("id") ON DELETE SET NULL ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "blob_uploads_usage_reservation_unique" ON "blob_uploads" ("usage_reservation_id") WHERE "usage_reservation_id" IS NOT NULL;
