ALTER TABLE "backup_runs" ADD COLUMN "generation" bigserial;
--> statement-breakpoint
ALTER TABLE "backup_runs" ALTER COLUMN "generation" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "backup_runs_generation_unique" ON "backup_runs" ("generation");
