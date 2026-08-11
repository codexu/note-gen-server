ALTER TABLE "risk_restrictions" ADD COLUMN "created_by_staff_id" uuid REFERENCES "staff_principals"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "risk_restrictions" ADD COLUMN "revoked_by_staff_id" uuid REFERENCES "staff_principals"("id") ON DELETE SET NULL;
