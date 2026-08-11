ALTER TABLE "legal_holds" ADD COLUMN "approved_by_staff_id" uuid REFERENCES "staff_principals"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "legal_holds" ADD COLUMN "released_by_staff_id" uuid REFERENCES "staff_principals"("id") ON DELETE SET NULL;
