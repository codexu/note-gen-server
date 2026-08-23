-- Remove current objects written into the wrong workspace type by unpublished
-- protocol drafts. Immutable object versions remain available as retained
-- history, but the invalid objects no longer participate in bootstrap or
-- current-content accounting.
DELETE FROM "objects" AS "o"
USING "workspaces" AS "w"
WHERE "o"."workspace_id" = "w"."id"
  AND (
    ("w"."workspace_type" = 'account-data' AND "o"."kind" IN ('note', 'folder'))
    OR (
      "w"."workspace_type" = 'library'
      AND "o"."kind" IN ('canvas', 'tag', 'mark', 'record', 'conversation', 'message', 'memory', 'setting')
    )
  );
