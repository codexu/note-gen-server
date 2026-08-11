-- Seed/reconcile the counters used by the first device admission gate.  Keep
-- reservations intact: an upload may be in flight while this migration runs.
INSERT INTO "account_usage" (
  "account_id", "active_object_bytes", "active_crdt_bytes", "active_blob_bytes", "active_objects",
  "active_devices", "active_workspaces", "reconciled_at", "updated_at"
)
SELECT
  a."id",
  COALESCE((
    SELECT SUM((length(o."ciphertext") * 3) / 4)::bigint
    FROM "objects" o JOIN "workspaces" w ON w."id" = o."workspace_id"
    WHERE w."account_id" = a."id" AND w."deleted_at" IS NULL AND o."deleted_at" IS NULL
  ), 0),
  COALESCE((
    SELECT SUM((length(d."checkpoint_ciphertext") * 3) / 4)::bigint
    FROM "sync_v2_documents" d JOIN "workspaces" w ON w."id" = d."workspace_id"
    WHERE w."account_id" = a."id" AND w."deleted_at" IS NULL AND d."checkpoint_ciphertext" IS NOT NULL
  ), 0) + COALESCE((
    SELECT SUM((length(u."ciphertext") * 3) / 4)::bigint
    FROM "sync_v2_updates" u JOIN "workspaces" w ON w."id" = u."workspace_id"
    WHERE w."account_id" = a."id" AND w."deleted_at" IS NULL
  ), 0),
  COALESCE((
    SELECT SUM(b."size")::bigint
    FROM "blobs" b JOIN "workspaces" w ON w."id" = b."workspace_id"
    WHERE w."account_id" = a."id" AND w."deleted_at" IS NULL AND b."state" = 'ready'
  ), 0),
  COALESCE((
    SELECT COUNT(*) FROM "objects" o JOIN "workspaces" w ON w."id" = o."workspace_id"
    WHERE w."account_id" = a."id" AND w."deleted_at" IS NULL AND o."deleted_at" IS NULL
  ), 0),
  COALESCE((SELECT COUNT(*) FROM "devices" d WHERE d."account_id" = a."id" AND d."revoked_at" IS NULL), 0),
  COALESCE((SELECT COUNT(*) FROM "workspaces" w WHERE w."account_id" = a."id" AND w."deleted_at" IS NULL), 0),
  now(), now()
FROM "accounts" a
ON CONFLICT ("account_id") DO UPDATE SET
  "active_object_bytes" = EXCLUDED."active_object_bytes",
  "active_crdt_bytes" = EXCLUDED."active_crdt_bytes",
  "active_blob_bytes" = EXCLUDED."active_blob_bytes",
  "active_objects" = EXCLUDED."active_objects",
  "active_devices" = EXCLUDED."active_devices",
  "active_workspaces" = EXCLUDED."active_workspaces",
  "reconciled_at" = now(),
  "revision" = "account_usage"."revision" + 1,
  "updated_at" = now();
