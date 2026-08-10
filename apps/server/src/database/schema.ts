import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, foreignKey, index, integer, jsonb, pgEnum, pgTable,
  primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

export const serverMetadata = pgTable('server_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const objectKind = pgEnum('object_kind', [
  'note', 'folder', 'asset', 'canvas', 'record', 'tag', 'mark', 'conversation',
  'memory', 'setting', 'yjs-checkpoint', 'yjs-update',
])
export const changeType = pgEnum('change_type', ['upsert', 'delete'])
export const blobState = pgEnum('blob_state', ['uploading', 'ready', 'deleting'])
export const keyEnvelopeType = pgEnum('key_envelope_type', ['passphrase', 'recovery', 'device', 'managed'])
export const deviceAuthorizationStatus = pgEnum('device_authorization_status', ['pending', 'approved', 'denied'])

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  login: text('login').notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
  isAdmin: boolean('is_admin').notNull().default(false),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex('accounts_login_unique').on(sql`lower(${table.login})`)])

export const adminAuditLogs = pgTable('admin_audit_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  actorAccountId: uuid('actor_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('admin_audit_logs_actor_idx').on(table.actorAccountId, table.createdAt),
  index('admin_audit_logs_created_idx').on(table.createdAt),
])

export const adminJobs = pgTable('admin_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorAccountId: uuid('actor_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  result: jsonb('result').$type<Record<string, unknown>>(),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('admin_jobs_created_idx').on(table.createdAt),
  index('admin_jobs_status_idx').on(table.status),
])

export const adminBackups = pgTable('admin_backups', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => adminJobs.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  size: bigint('size', { mode: 'bigint' }),
  status: text('status').notNull().default('creating'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [uniqueIndex('admin_backups_filename_unique').on(table.filename)])

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  encryptionPublicKey: text('encryption_public_key'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [index('devices_account_idx').on(table.accountId)])

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('refresh_tokens_hash_unique').on(table.tokenHash),
  index('refresh_tokens_device_idx').on(table.deviceId),
])

export const webSessions = pgTable('web_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  csrfTokenHash: text('csrf_token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastIp: text('last_ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('web_sessions_token_hash_unique').on(table.tokenHash),
  index('web_sessions_account_idx').on(table.accountId),
  index('web_sessions_expiry_idx').on(table.expiresAt),
])

export const deviceAuthorizations = pgTable('device_authorizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceCodeHash: text('device_code_hash').notNull(),
  userCode: text('user_code').notNull(),
  deviceId: uuid('device_id').notNull(),
  deviceName: text('device_name').notNull(),
  platform: text('platform').notNull(),
  encryptionPublicKey: text('encryption_public_key'),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  status: deviceAuthorizationStatus('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('device_authorizations_device_code_unique').on(table.deviceCodeHash),
  uniqueIndex('device_authorizations_user_code_unique').on(table.userCode),
  index('device_authorizations_expiry_idx').on(table.expiresAt),
  index('device_authorizations_account_idx').on(table.accountId),
])

export const devicePairings = pgTable('device_pairings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('device_pairings_token_hash_unique').on(table.tokenHash),
  index('device_pairings_account_idx').on(table.accountId),
  index('device_pairings_expiry_idx').on(table.expiresAt),
])

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  nameCiphertext: text('name_ciphertext').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  latestSequence: bigint('latest_sequence', { mode: 'bigint' }).notNull().default(sql`0`),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index('workspaces_account_idx').on(table.accountId),
  uniqueIndex('workspaces_active_default_unique')
    .on(table.accountId)
    .where(sql`${table.isDefault} = true and ${table.deletedAt} is null`),
])

export const workspaceKeys = pgTable('workspace_keys', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  keyVersion: integer('key_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.keyVersion] })])

export const workspaceKeyEnvelopes = pgTable('workspace_key_envelopes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  keyVersion: integer('key_version').notNull(),
  type: keyEnvelopeType('envelope_type').notNull(),
  recipientId: text('recipient_id'),
  wrappedKey: text('wrapped_key').notNull(),
  kdfSalt: text('kdf_salt'),
  kdfParams: jsonb('kdf_params').$type<Record<string, number>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('workspace_key_envelopes_key_idx').on(table.workspaceId, table.keyVersion),
  unique('workspace_key_envelopes_recipient_unique').on(
    table.workspaceId, table.keyVersion, table.type, table.recipientId,
  ).nullsNotDistinct(),
  foreignKey({
    columns: [table.workspaceId, table.keyVersion],
    foreignColumns: [workspaceKeys.workspaceId, workspaceKeys.keyVersion],
    name: 'workspace_key_envelopes_key_fk',
  }).onDelete('cascade'),
])

export const objects = pgTable('objects', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  objectId: uuid('object_id').notNull(),
  kind: objectKind('kind').notNull(),
  parentObjectId: uuid('parent_object_id'),
  nameCiphertext: text('name_ciphertext'),
  nameBlindIndex: text('name_blind_index'),
  currentRevision: bigint('current_revision', { mode: 'bigint' }).notNull(),
  ciphertext: text('ciphertext').notNull(),
  ciphertextHash: text('ciphertext_hash').notNull(),
  keyVersion: integer('key_version').notNull(),
  blobRefs: jsonb('blob_refs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.objectId] }),
  index('objects_workspace_kind_idx').on(table.workspaceId, table.kind),
  index('objects_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
  index('objects_sibling_name_blind_idx')
    .on(table.workspaceId, table.parentObjectId, table.nameBlindIndex)
    .where(sql`${table.deletedAt} is null and ${table.nameBlindIndex} is not null`),
  foreignKey({
    columns: [table.workspaceId, table.keyVersion],
    foreignColumns: [workspaceKeys.workspaceId, workspaceKeys.keyVersion],
    name: 'objects_workspace_key_fk',
  }),
])

export const adminTestObjects = pgTable('admin_test_objects', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  objectId: uuid('object_id').notNull(),
  kind: objectKind('kind').notNull(),
  createdByAccountId: uuid('created_by_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.objectId] }),
  index('admin_test_objects_created_idx').on(table.createdAt),
])

export const objectVersions = pgTable('object_versions', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  objectId: uuid('object_id').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  kind: objectKind('kind').notNull(),
  parentObjectId: uuid('parent_object_id'),
  nameCiphertext: text('name_ciphertext'),
  nameBlindIndex: text('name_blind_index'),
  ciphertext: text('ciphertext').notNull(),
  ciphertextHash: text('ciphertext_hash').notNull(),
  keyVersion: integer('key_version').notNull(),
  blobRefs: jsonb('blob_refs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id),
  deleted: boolean('deleted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.objectId, table.revision] }),
  index('object_versions_created_idx').on(table.workspaceId, table.createdAt),
  index('object_versions_sequence_idx').on(table.workspaceId, table.sequence),
  foreignKey({
    columns: [table.workspaceId, table.keyVersion],
    foreignColumns: [workspaceKeys.workspaceId, workspaceKeys.keyVersion],
    name: 'object_versions_workspace_key_fk',
  }),
])

export const syncV2ResourceBindings = pgTable('sync_v2_resource_bindings', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerObjectId: uuid('owner_object_id').notNull(),
  ownerRevision: bigint('owner_revision', { mode: 'bigint' }).notNull(),
  resourceObjectId: uuid('resource_object_id').notNull(),
  resourceRevision: bigint('resource_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.ownerObjectId, table.ownerRevision, table.resourceObjectId] }),
  index('sync_v2_resource_bindings_resource_idx')
    .on(table.workspaceId, table.resourceObjectId, table.resourceRevision),
  index('sync_v2_resource_bindings_owner_idx')
    .on(table.workspaceId, table.ownerObjectId, table.ownerRevision),
  foreignKey({
    columns: [table.workspaceId, table.ownerObjectId, table.ownerRevision],
    foreignColumns: [objectVersions.workspaceId, objectVersions.objectId, objectVersions.revision],
    name: 'sync_v2_resource_bindings_owner_version_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.workspaceId, table.resourceObjectId, table.resourceRevision],
    foreignColumns: [objectVersions.workspaceId, objectVersions.objectId, objectVersions.revision],
    name: 'sync_v2_resource_bindings_resource_version_fk',
  }),
])

export const changes = pgTable('changes', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  objectId: uuid('object_id').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  operationId: uuid('operation_id').notNull(),
  sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id),
  type: changeType('change_type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('changes_workspace_sequence_unique').on(table.workspaceId, table.sequence),
  index('changes_workspace_object_idx').on(table.workspaceId, table.objectId),
  index('changes_created_idx').on(table.createdAt),
])

export const operations = pgTable('operations', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  operationId: uuid('operation_id').notNull(),
  sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id),
  requestHash: text('request_hash'),
  resultRevision: bigint('result_revision', { mode: 'bigint' }).notNull(),
  resultSequence: bigint('result_sequence', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.operationId] }),
  index('operations_created_idx').on(table.createdAt),
])

export const deviceCursors = pgTable('device_cursors', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  acknowledgedSequence: bigint('acknowledged_sequence', { mode: 'bigint' }).notNull().default(sql`0`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.deviceId] })])

export const bootstrapSessions = pgTable('bootstrap_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  snapshotSequence: bigint('snapshot_sequence', { mode: 'bigint' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('bootstrap_sessions_expiry_idx').on(table.expiresAt),
  index('bootstrap_sessions_device_idx').on(table.workspaceId, table.deviceId),
])

export const blobs = pgTable('blobs', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  blobId: text('blob_id').notNull(),
  size: bigint('size', { mode: 'bigint' }).notNull(),
  ciphertextHash: text('ciphertext_hash').notNull(),
  storageKey: text('storage_key').notNull(),
  state: blobState('state').notNull(),
  lastReferencedAt: timestamp('last_referenced_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.blobId] }),
  uniqueIndex('blobs_storage_key_unique').on(table.storageKey),
  index('blobs_gc_idx').on(table.state, table.lastReferencedAt),
])

export const blobUploads = pgTable('blob_uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  blobId: text('blob_id').notNull(),
  storageKey: text('storage_key').notNull(),
  providerUploadId: text('provider_upload_id').notNull(),
  expectedSize: bigint('expected_size', { mode: 'bigint' }).notNull(),
  receivedSize: bigint('received_size', { mode: 'bigint' }).notNull().default(sql`0`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  completingAt: timestamp('completing_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('blob_uploads_workspace_blob_unique').on(table.workspaceId, table.blobId),
  index('blob_uploads_workspace_blob_idx').on(table.workspaceId, table.blobId),
  index('blob_uploads_expiry_idx').on(table.expiresAt),
])

export const blobUploadParts = pgTable('blob_upload_parts', {
  uploadId: uuid('upload_id').notNull().references(() => blobUploads.id, { onDelete: 'cascade' }),
  partNumber: integer('part_number').notNull(),
  size: bigint('size', { mode: 'bigint' }).notNull(),
  etag: text('etag').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.uploadId, table.partNumber] })])

// The sync protocol keeps lifecycle commands, CRDT traffic and conflict state in
// one durable workspace sequence while reusing the object, version and Blob tables.
export const syncV2Commands = pgTable('sync_v2_commands', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  commandId: uuid('command_id').notNull(),
  sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id),
  requestHash: text('request_hash').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.commandId] }),
  index('sync_v2_commands_created_idx').on(table.createdAt),
])

export const syncV2Events = pgTable('sync_v2_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  eventId: uuid('event_id').notNull().defaultRandom(),
  commandId: uuid('command_id').notNull(),
  sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id),
  type: text('event_type').notNull(),
  objectId: uuid('object_id'),
  documentId: text('document_id'),
  documentSequence: bigint('document_sequence', { mode: 'bigint' }),
  keyVersion: integer('key_version'),
  ciphertext: text('ciphertext'),
  ciphertextHash: text('ciphertext_hash'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('sync_v2_events_workspace_sequence_unique').on(table.workspaceId, table.sequence),
  uniqueIndex('sync_v2_events_workspace_event_unique').on(table.workspaceId, table.eventId),
  index('sync_v2_events_document_idx').on(table.workspaceId, table.documentId, table.documentSequence),
  index('sync_v2_events_created_idx').on(table.createdAt),
])

export const syncV2Documents = pgTable('sync_v2_documents', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull(),
  objectId: uuid('object_id').notNull(),
  kind: objectKind('kind').notNull(),
  latestDocumentSequence: bigint('latest_document_sequence', { mode: 'bigint' }).notNull().default(sql`0`),
  checkpointDocumentSequence: bigint('checkpoint_document_sequence', { mode: 'bigint' }).notNull().default(sql`0`),
  checkpointId: uuid('checkpoint_id'),
  checkpointKeyVersion: integer('checkpoint_key_version'),
  checkpointCiphertext: text('checkpoint_ciphertext'),
  checkpointCiphertextHash: text('checkpoint_ciphertext_hash'),
  materializedRevision: bigint('materialized_revision', { mode: 'bigint' }),
  ...timestamps,
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.documentId] }),
  uniqueIndex('sync_v2_documents_object_unique').on(table.workspaceId, table.objectId),
])

export const syncV2Updates = pgTable('sync_v2_updates', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull(),
  documentSequence: bigint('document_sequence', { mode: 'bigint' }).notNull(),
  updateId: uuid('update_id').notNull(),
  eventSequence: bigint('event_sequence', { mode: 'bigint' }).notNull(),
  sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id),
  keyVersion: integer('key_version').notNull(),
  ciphertext: text('ciphertext').notNull(),
  ciphertextHash: text('ciphertext_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.documentId, table.documentSequence] }),
  uniqueIndex('sync_v2_updates_id_unique').on(table.workspaceId, table.updateId),
  index('sync_v2_updates_event_idx').on(table.workspaceId, table.eventSequence),
])

export const syncV2Checkpoints = pgTable('sync_v2_checkpoints', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  checkpointId: uuid('checkpoint_id').notNull(),
  documentId: text('document_id').notNull(),
  objectId: uuid('object_id').notNull(),
  coversDocumentSequence: bigint('covers_document_sequence', { mode: 'bigint' }).notNull(),
  eventSequence: bigint('event_sequence', { mode: 'bigint' }).notNull(),
  materializedRevision: bigint('materialized_revision', { mode: 'bigint' }),
  keyVersion: integer('key_version').notNull(),
  ciphertext: text('ciphertext').notNull(),
  ciphertextHash: text('ciphertext_hash').notNull(),
  sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.checkpointId] }),
  index('sync_v2_checkpoints_document_idx').on(table.workspaceId, table.documentId, table.eventSequence),
])

export const syncV2Conflicts = pgTable('sync_v2_conflicts', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  conflictId: uuid('conflict_id').notNull(),
  objectId: uuid('object_id').notNull(),
  kind: objectKind('kind').notNull(),
  type: text('conflict_type').notNull(),
  status: text('status').notNull().default('unresolved'),
  expectedRevision: bigint('expected_revision', { mode: 'bigint' }),
  expectedDocumentSequence: bigint('expected_document_sequence', { mode: 'bigint' }),
  keyVersion: integer('key_version').notNull(),
  ciphertext: text('ciphertext').notNull(),
  ciphertextHash: text('ciphertext_hash').notNull(),
  createdSequence: bigint('created_sequence', { mode: 'bigint' }).notNull(),
  resolvedSequence: bigint('resolved_sequence', { mode: 'bigint' }),
  resolvedByDeviceId: uuid('resolved_by_device_id').references(() => devices.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.conflictId] }),
  index('sync_v2_conflicts_status_idx').on(table.workspaceId, table.status, table.createdAt),
  index('sync_v2_conflicts_object_idx').on(table.workspaceId, table.objectId),
])

export const syncV2BootstrapSessions = pgTable('sync_v2_bootstrap_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  snapshotSequence: bigint('snapshot_sequence', { mode: 'bigint' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('sync_v2_bootstrap_sessions_workspace_idx').on(table.workspaceId, table.expiresAt),
])

export const syncV2BootstrapObjects = pgTable('sync_v2_bootstrap_objects', {
  sessionId: uuid('session_id').notNull().references(() => syncV2BootstrapSessions.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  objectId: uuid('object_id').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  documentId: text('document_id'),
  latestDocumentSequence: bigint('latest_document_sequence', { mode: 'bigint' }),
  checkpointDocumentSequence: bigint('checkpoint_document_sequence', { mode: 'bigint' }),
  checkpointId: uuid('checkpoint_id'),
  checkpointKeyVersion: integer('checkpoint_key_version'),
  checkpointCiphertext: text('checkpoint_ciphertext'),
  checkpointCiphertextHash: text('checkpoint_ciphertext_hash'),
  materializedRevision: bigint('materialized_revision', { mode: 'bigint' }),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.objectId] }),
  index('sync_v2_bootstrap_objects_workspace_idx').on(table.workspaceId, table.sessionId, table.objectId),
])
