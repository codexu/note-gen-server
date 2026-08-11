ALTER TABLE "deployment_settings"
ADD COLUMN "runtime_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL;
