ALTER TABLE "sync_v2_bootstrap_objects" RENAME TO "sync_bootstrap_objects";--> statement-breakpoint
ALTER TABLE "sync_v2_bootstrap_sessions" RENAME TO "sync_bootstrap_sessions";--> statement-breakpoint
ALTER TABLE "sync_v2_checkpoints" RENAME TO "sync_checkpoints";--> statement-breakpoint
ALTER TABLE "sync_v2_commands" RENAME TO "sync_commands";--> statement-breakpoint
ALTER TABLE "sync_v2_conflicts" RENAME TO "sync_conflicts";--> statement-breakpoint
ALTER TABLE "sync_v2_documents" RENAME TO "sync_documents";--> statement-breakpoint
ALTER TABLE "sync_v2_events" RENAME TO "sync_events";--> statement-breakpoint
ALTER TABLE "sync_v2_resource_bindings" RENAME TO "sync_resource_bindings";--> statement-breakpoint
ALTER TABLE "sync_v2_updates" RENAME TO "sync_updates";--> statement-breakpoint

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT table_name, constraint_name,
      regexp_replace(constraint_name, '^sync_v2_', 'sync_') AS current_name
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name IN (
        'sync_bootstrap_objects', 'sync_bootstrap_sessions', 'sync_checkpoints',
        'sync_commands', 'sync_conflicts', 'sync_documents', 'sync_events',
        'sync_resource_bindings', 'sync_updates'
      )
      AND constraint_name LIKE 'sync_v2_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
      item.table_name, item.constraint_name, item.current_name
    );
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT index_name,
      regexp_replace(index_name, '^sync_v2_', 'sync_') AS current_name
    FROM (
      SELECT DISTINCT index_class.relname AS index_name
      FROM pg_index
      JOIN pg_class table_class ON table_class.oid = pg_index.indrelid
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
      WHERE table_namespace.nspname = 'public'
        AND table_class.relname IN (
          'sync_bootstrap_objects', 'sync_bootstrap_sessions', 'sync_checkpoints',
          'sync_commands', 'sync_conflicts', 'sync_documents', 'sync_events',
          'sync_resource_bindings', 'sync_updates'
        )
        AND index_class.relname LIKE 'sync_v2_%'
    ) indexes
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', item.index_name, item.current_name);
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT sequence_name,
      regexp_replace(sequence_name, '^sync_v2_', 'sync_') AS current_name
    FROM information_schema.sequences
    WHERE sequence_schema = 'public'
      AND sequence_name LIKE 'sync_v2_%'
  LOOP
    EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', item.sequence_name, item.current_name);
  END LOOP;
END $$;
