import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgTable,
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

export const deploymentMode = pgEnum('deployment_mode', ['hosted', 'self-hosted'])
export const registrationPolicy = pgEnum('registration_policy', ['bootstrap', 'disabled', 'invitation', 'public'])
export const selfHostedLifecycle = pgEnum('self_hosted_lifecycle', ['uninitialized', 'ready'])
export const backgroundJobStatus = pgEnum('background_job_status', ['pending', 'running', 'succeeded', 'dead_letter', 'cancelled'])
export const outboxMessageStatus = pgEnum('outbox_message_status', ['pending', 'sending', 'sent', 'dead_letter', 'delivery_unknown'])
export const bootstrapCredentialSource = pgEnum('bootstrap_credential_source', ['cli', 'legacy_environment'])
export const invitationActorType = pgEnum('invitation_actor_type', ['account', 'staff', 'system'])
export const accountIdentityState = pgEnum('account_identity_state', ['pending_verification', 'active', 'legacy_migration'])
export const accountIdentityKind = pgEnum('account_identity_kind', ['username', 'email'])
export const accountLoginClaimKind = pgEnum('account_login_claim_kind', ['legacy_username', 'username', 'email'])
export const accountActionTokenPurpose = pgEnum('account_action_token_purpose', ['verify_email', 'reset_password', 'change_email'])
export const usageReservationStatus = pgEnum('usage_reservation_status', ['reserved', 'external_started', 'committed', 'released', 'expired', 'reconciling'])
export const backupRunStatus = pgEnum('backup_run_status', ['queued', 'preparing', 'draining', 'dumping', 'copying', 'verifying', 'ready', 'failed', 'deleting'])
export const restoreDrillMode = pgEnum('restore_drill_mode', ['verify-only', 'isolated-restore', 'full-drill'])
export const restoreMarkerMode = pgEnum('restore_marker_mode', ['preserve', 'clone'])
export const restoreSanitationStatus = pgEnum('restore_sanitation_status', ['pending', 'running', 'complete', 'failed'])
export const riskRestrictionSubjectType = pgEnum('risk_restriction_subject_type', ['account', 'identity', 'device', 'ip_prefix'])
export const riskRestrictionScope = pgEnum('risk_restriction_scope', ['registration', 'authentication', 'recovery', 'device', 'sync_write', 'blob', 'billing', 'all'])
export const riskRestrictionAction = pgEnum('risk_restriction_action', ['challenge', 'lock', 'read_only', 'deny', 'review'])
export const riskRestrictionSource = pgEnum('risk_restriction_source', ['automatic', 'staff', 'provider'])
export const riskProviderEventStatus = pgEnum('risk_provider_event_status', ['pending', 'processing', 'processed', 'ignored', 'failed', 'dead_letter'])
export const dataRequestType = pgEnum('data_request_type', ['access', 'export', 'correct', 'delete', 'restrict', 'object'])
export const dataRequestStatus = pgEnum('data_request_status', ['submitted', 'identity_check', 'queued', 'processing', 'awaiting_user', 'completed', 'rejected', 'canceled', 'held', 'failed'])
export const deletionCaseStatus = pgEnum('deletion_case_status', ['requested', 'cooling_off', 'scheduled', 'held', 'purging', 'completed', 'canceled', 'failed'])
export const deletionFenceState = pgEnum('deletion_fence_state', ['cooling_off', 'scheduled', 'purging', 'completed', 'canceled'])
export const deletionStepState = pgEnum('deletion_step_state', ['pending', 'running', 'completed', 'failed', 'skipped'])
export const billingProviderEnvironment = pgEnum('billing_provider_environment', ['test', 'live'])
export const billingPlanInterval = pgEnum('billing_plan_interval', ['month', 'year'])
export const accountSubscriptionStatus = pgEnum('account_subscription_status', ['incomplete', 'trialing', 'active', 'past_due', 'grace', 'paused', 'ended', 'review'])
export const entitlementGrantSource = pgEnum('entitlement_grant_source', ['promotion', 'support', 'migration', 'staff'])
export const billingWebhookEventStatus = pgEnum('billing_webhook_event_status', ['pending', 'processing', 'processed', 'ignored', 'failed', 'dead_letter'])
export const billingCheckoutStatus = pgEnum('billing_checkout_status', ['pending_provider', 'open', 'completed', 'linked', 'expired', 'failed', 'reconciling'])
export const maintenanceMode = pgEnum('maintenance_mode', ['normal', 'read_only', 'write_drain', 'offline'])
export const supportCaseCategory = pgEnum('support_case_category', ['account', 'sync', 'device', 'encryption', 'billing', 'privacy', 'abuse', 'other'])
export const supportCaseSeverity = pgEnum('support_case_severity', ['normal', 'high', 'urgent'])
export const supportCaseStatus = pgEnum('support_case_status', ['open', 'waiting_for_support', 'waiting_for_user', 'resolved', 'closed', 'spam'])
export const supportCaseSource = pgEnum('support_case_source', ['web', 'client', 'email', 'staff', 'external'])
export const supportMessageAuthorType = pgEnum('support_message_author_type', ['account', 'staff', 'system'])
export const supportMessageVisibility = pgEnum('support_message_visibility', ['customer', 'internal'])

/** Hosted operators deliberately live outside customer accounts. Role strings
 * remain open-ended; the code permission registry is the authorization fact. */
export const staffPrincipals = pgTable('staff_principals', {
  id: uuid('id').primaryKey().defaultRandom(), externalIssuer: text('external_issuer').notNull(), externalSubject: text('external_subject').notNull(),
  displayName: text('display_name').notNull(), email: text('email'), disabledAt: timestamp('disabled_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('staff_principals_issuer_subject_unique').on(table.externalIssuer, table.externalSubject), index('staff_principals_active_idx').on(table.disabledAt)])

export const staffSessions = pgTable('staff_sessions', {
  id: uuid('id').primaryKey().defaultRandom(), staffId: uuid('staff_id').notNull().references(() => staffPrincipals.id, { onDelete: 'cascade' }),
  authStrength: text('auth_strength').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('staff_sessions_active_idx').on(table.staffId, table.expiresAt)])

export const staffRoleAssignments = pgTable('staff_role_assignments', {
  id: uuid('id').primaryKey().defaultRandom(), staffId: uuid('staff_id').notNull().references(() => staffPrincipals.id, { onDelete: 'cascade' }),
  roleKey: text('role_key').notNull(), scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  expiresAt: timestamp('expires_at', { withTimezone: true }), revokedAt: timestamp('revoked_at', { withTimezone: true }), assignedByStaffId: uuid('assigned_by_staff_id').references(() => staffPrincipals.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('staff_role_assignments_staff_role_idx').on(table.staffId, table.roleKey), index('staff_role_assignments_active_idx').on(table.staffId, table.expiresAt)])

/** The single durable source for instance-wide deployment policy. */
export const deploymentSettings = pgTable('deployment_settings', {
  id: boolean('id').primaryKey().default(true),
  deploymentMode: deploymentMode('deployment_mode').notNull(),
  registrationPolicy: registrationPolicy('registration_policy').notNull(),
  selfHostedLifecycle: selfHostedLifecycle('self_hosted_lifecycle'),
  adminRepairRequired: boolean('admin_repair_required').notNull().default(false),
  /** Monotonic instance-wide credential generation, advanced by offline restore. */
  instanceAuthEpoch: bigint('instance_auth_epoch', { mode: 'bigint' }).notNull().default(sql`0`),
  tokenNotBefore: timestamp('token_not_before', { withTimezone: true }).notNull().defaultNow(),
  authEpochEnforced: boolean('auth_epoch_enforced').notNull().default(false),
  /** Administrator-managed values that can be changed without restarting the instance. */
  runtimeConfiguration: jsonb('runtime_configuration').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  configurationRevision: bigint('configuration_revision', { mode: 'bigint' }).notNull().default(sql`1`),
  initializedAt: timestamp('initialized_at', { withTimezone: true }),
  initializedByAccountId: uuid('initialized_by_account_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // PostgreSQL does not enforce singleton cardinality from a boolean primary key alone.
  // This check makes the intended sole row explicit and keeps accidental ids invalid.
  // The migration declares the same constraint for existing databases.
])

/** Instance-wide write barrier, separate from deployment configuration revision. */
export const maintenanceState = pgTable('maintenance_state', {
  id: boolean('id').primaryKey().default(true),
  mode: maintenanceMode('mode').notNull().default('normal'),
  generation: bigint('generation', { mode: 'bigint' }).notNull().default(sql`0`),
  reason: text('reason'),
  enteredAt: timestamp('entered_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const objectKind = pgEnum('object_kind', [
  'note', 'folder', 'asset', 'canvas', 'record', 'tag', 'mark', 'conversation',
  'memory', 'setting', 'yjs-checkpoint', 'yjs-update',
])
export const changeType = pgEnum('change_type', ['upsert', 'delete'])
export const blobState = pgEnum('blob_state', ['uploading', 'ready', 'deleting'])
export const keyEnvelopeType = pgEnum('key_envelope_type', ['passphrase', 'recovery', 'device', 'managed'])
export const keyEnvelopeStatus = pgEnum('key_envelope_status', ['active', 'revoked'])
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
  identityState: accountIdentityState('identity_state').notNull().default('legacy_migration'),
  credentialEpoch: bigint('credential_epoch', { mode: 'bigint' }).notNull().default(sql`0`),
  ...timestamps,
}, (table) => [uniqueIndex('accounts_login_unique').on(sql`lower(${table.login})`)])

export const accountIdentities = pgTable('account_identities', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  kind: accountIdentityKind('kind').notNull(), identifier: text('identifier').notNull(), normalizedIdentifier: text('normalized_identifier').notNull(),
  isPrimary: boolean('is_primary').notNull().default(false), verifiedAt: timestamp('verified_at', { withTimezone: true }), disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('account_identities_active_unique').on(table.kind, table.normalizedIdentifier).where(sql`${table.disabledAt} is null`), index('account_identities_account_idx').on(table.accountId)])

export const accountLoginClaims = pgTable('account_login_claims', {
  normalizedLoginKey: text('normalized_login_key').primaryKey(), accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
  identityId: uuid('identity_id').references(() => accountIdentities.id, { onDelete: 'restrict' }), kind: accountLoginClaimKind('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), releasedAt: timestamp('released_at', { withTimezone: true }), reusableAfter: timestamp('reusable_after', { withTimezone: true }),
})

export const accountActionTokens = pgTable('account_action_tokens', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  identityId: uuid('identity_id').references(() => accountIdentities.id, { onDelete: 'cascade' }), purpose: accountActionTokenPurpose('purpose').notNull(),
  tokenKeyId: text('token_key_id').notNull(), tokenHash: text('token_hash').notNull(), targetNormalized: text('target_normalized'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }), revokedAt: timestamp('revoked_at', { withTimezone: true }), requestedIpHash: text('requested_ip_hash'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('account_action_tokens_hash_unique').on(table.tokenHash), index('account_action_tokens_account_idx').on(table.accountId, table.expiresAt)])

export const stepUpActorType = pgEnum('step_up_actor_type', ['account', 'staff'])

export const stepUpGrants = pgTable('step_up_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenDigest: text('token_digest').notNull(), digestKeyId: text('digest_key_id').notNull(),
  actorType: stepUpActorType('actor_type').notNull(), actorId: uuid('actor_id').notNull(),
  sessionId: uuid('session_id').notNull(), actionAudience: text('action_audience').notNull(),
  authMethods: text('auth_methods').array().notNull(), requestHash: text('request_hash').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }), revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('step_up_grants_token_digest_unique').on(table.tokenDigest),
  index('step_up_grants_actor_session_expiry_idx').on(table.actorId, table.sessionId, table.expiresAt),
])

export const accountLoginClaimConflicts = pgTable('account_login_claim_conflicts', {
  normalizedLoginKey: text('normalized_login_key').notNull(), candidateAccountId: uuid('candidate_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  candidateIdentityId: uuid('candidate_identity_id').references(() => accountIdentities.id, { onDelete: 'set null' }), candidateKind: accountLoginClaimKind('candidate_kind').notNull(),
  status: text('status').notNull().default('quarantined'), resolutionRef: text('resolution_ref'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.normalizedLoginKey, table.candidateAccountId, table.candidateKind] }), index('account_login_claim_conflicts_status_idx').on(table.status, table.createdAt)])

export const accountUsage = pgTable('account_usage', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  activeObjectBytes: bigint('active_object_bytes', { mode: 'bigint' }).notNull().default(sql`0`), activeCrdtBytes: bigint('active_crdt_bytes', { mode: 'bigint' }).notNull().default(sql`0`),
  activeBlobBytes: bigint('active_blob_bytes', { mode: 'bigint' }).notNull().default(sql`0`), reservedBlobBytes: bigint('reserved_blob_bytes', { mode: 'bigint' }).notNull().default(sql`0`), retainedBytes: bigint('retained_bytes', { mode: 'bigint' }).notNull().default(sql`0`),
  activeObjects: bigint('active_objects', { mode: 'bigint' }).notNull().default(sql`0`), activeDevices: bigint('active_devices', { mode: 'bigint' }).notNull().default(sql`0`), activeWorkspaces: bigint('active_workspaces', { mode: 'bigint' }).notNull().default(sql`0`),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(sql`0`), reconciledAt: timestamp('reconciled_at', { withTimezone: true }), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const usageReservations = pgTable('usage_reservations', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }), workspaceId: uuid('workspace_id'),
  metric: text('metric').notNull(), quantity: bigint('quantity', { mode: 'bigint' }).notNull(), sourceType: text('source_type').notNull(), sourceId: text('source_id').notNull(), requestHash: text('request_hash').notNull(), providerUploadRef: text('provider_upload_ref'),
  status: usageReservationStatus('status').notNull().default('reserved'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [uniqueIndex('usage_reservations_workspace_source_unique').on(table.accountId, table.workspaceId, table.sourceType, table.sourceId, table.metric).where(sql`${table.workspaceId} is not null`), uniqueIndex('usage_reservations_account_source_unique').on(table.accountId, table.sourceType, table.sourceId, table.metric).where(sql`${table.workspaceId} is null`), index('usage_reservations_expiry_idx').on(table.status, table.expiresAt)])

export const usageEvents = pgTable('usage_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }), workspaceId: uuid('workspace_id'),
  metric: text('metric').notNull(), delta: bigint('delta', { mode: 'bigint' }).notNull(), resultingValue: bigint('resulting_value', { mode: 'bigint' }), sourceType: text('source_type').notNull(), sourceId: text('source_id').notNull(), requestHash: text('request_hash').notNull(), idempotencyKey: text('idempotency_key').notNull(), occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(), billingPeriod: text('billing_period'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
}, (table) => [uniqueIndex('usage_events_workspace_idempotency_unique').on(table.accountId, table.workspaceId, table.idempotencyKey).where(sql`${table.workspaceId} is not null`), uniqueIndex('usage_events_account_idempotency_unique').on(table.accountId, table.idempotencyKey).where(sql`${table.workspaceId} is null`), index('usage_events_account_occurred_idx').on(table.accountId, table.occurredAt)])

export const backupPolicies = pgTable('backup_policies', {
  id: uuid('id').primaryKey().defaultRandom(), enabled: boolean('enabled').notNull().default(false), schedule: text('schedule').notNull(), targetRef: text('target_ref').notNull(), retention: jsonb('retention').$type<Record<string, unknown>>().notNull(), encryptionKeyId: text('encryption_key_id'),
  createdBy: uuid('created_by'), updatedBy: uuid('updated_by'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const backupRuns = pgTable('backup_runs', {
  id: uuid('id').primaryKey().defaultRandom(), generation: bigserial('generation', { mode: 'bigint' }).notNull(), jobId: uuid('job_id'), policyId: uuid('policy_id').references(() => backupPolicies.id, { onDelete: 'set null' }), status: backupRunStatus('status').notNull().default('queued'), snapshotAt: timestamp('snapshot_at', { withTimezone: true }), manifestRef: text('manifest_ref'), databaseBytes: bigint('database_bytes', { mode: 'bigint' }), blobCount: bigint('blob_count', { mode: 'bigint' }), blobBytes: bigint('blob_bytes', { mode: 'bigint' }), errorCode: text('error_code'), checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [uniqueIndex('backup_runs_generation_unique').on(table.generation), index('backup_runs_status_idx').on(table.status, table.createdAt)])

/** Immutable artifact inventory for a unified backup run. `path` is relative
 * to the run root and is verified before any restore sanitation is allowed. */
export const backupArtifacts = pgTable('backup_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(), backupRunId: uuid('backup_run_id').notNull().references(() => backupRuns.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), relativePath: text('relative_path').notNull(), sha256: text('sha256').notNull(), size: bigint('size', { mode: 'bigint' }).notNull(),
  sourceRef: text('source_ref'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('backup_artifacts_run_path_unique').on(table.backupRunId, table.relativePath),
  index('backup_artifacts_run_idx').on(table.backupRunId),
  check('backup_artifacts_size_check', sql`${table.size} >= 0`),
  check('backup_artifacts_path_check', sql`length(${table.relativePath}) > 0`),
])

export const restoreDrills = pgTable('restore_drills', {
  id: uuid('id').primaryKey().defaultRandom(), backupRunId: uuid('backup_run_id').notNull().references(() => backupRuns.id, { onDelete: 'restrict' }), mode: restoreDrillMode('mode').notNull(), status: text('status').notNull(), checks: jsonb('checks').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`), actorId: uuid('actor_id'), startedAt: timestamp('started_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
})

export const restoreMarkers = pgTable('restore_markers', {
  id: uuid('id').primaryKey().defaultRandom(), backupId: uuid('backup_id').notNull(), mode: restoreMarkerMode('mode').notNull(), oldSyncEpoch: uuid('old_sync_epoch'), newSyncEpoch: uuid('new_sync_epoch').notNull(), restoredThroughSequenceByWorkspace: jsonb('restored_through_sequence_by_workspace').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`), sanitationStatus: restoreSanitationStatus('sanitation_status').notNull().default('pending'), authEpochAfter: bigint('auth_epoch_after', { mode: 'bigint' }), bootstrapTokenCutoff: timestamp('bootstrap_token_cutoff', { withTimezone: true }), bootstrapReissueRequired: boolean('bootstrap_reissue_required').notNull().default(false), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [uniqueIndex('restore_markers_new_epoch_unique').on(table.newSyncEpoch)])

/** Immutable local break-glass facts; they are deliberately not attributed to
 * a customer account or a hosted staff principal. */
export const restoreCredentialReviews = pgTable('restore_credential_reviews', {
  id: uuid('id').primaryKey().defaultRandom(), restoreMarkerId: uuid('restore_marker_id').notNull().references(() => restoreMarkers.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }), decision: text('decision').notNull(),
  operatorKind: text('operator_kind').notNull().default('local-operator'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('restore_credential_reviews_marker_account_unique').on(table.restoreMarkerId, table.accountId)])

export const riskEvents = pgTable('risk_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), eventType: text('event_type').notNull(), accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }), identityHash: text('identity_hash'), deviceId: uuid('device_id'), ipPrefixHash: text('ip_prefix_hash'), userAgentFamily: text('user_agent_family'), requestId: text('request_id').notNull(), outcome: text('outcome').notNull(), reasonCodes: text('reason_codes').array().notNull().default(sql`'{}'::text[]`), score: integer('score'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('risk_events_account_created_idx').on(table.accountId, table.createdAt), index('risk_events_event_created_idx').on(table.eventType, table.createdAt)])

export const riskRestrictions = pgTable('risk_restrictions', {
  id: uuid('id').primaryKey().defaultRandom(), subjectType: riskRestrictionSubjectType('subject_type').notNull(), subjectRef: text('subject_ref').notNull(), scope: riskRestrictionScope('scope').notNull(), action: riskRestrictionAction('action').notNull(), reasonCode: text('reason_code').notNull(), source: riskRestrictionSource('source').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }), createdBy: uuid('created_by'), createdByStaffId: uuid('created_by_staff_id').references(() => staffPrincipals.id, { onDelete: 'set null' }), revokedAt: timestamp('revoked_at', { withTimezone: true }), revokedBy: uuid('revoked_by'), revokedByStaffId: uuid('revoked_by_staff_id').references(() => staffPrincipals.id, { onDelete: 'set null' }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('risk_restrictions_active_unique').on(table.subjectType, table.subjectRef, table.scope, table.action).where(sql`${table.revokedAt} is null`), index('risk_restrictions_subject_idx').on(table.subjectType, table.subjectRef, table.expiresAt)])

export const challengeConsumptions = pgTable('challenge_consumptions', {
  tokenDigest: text('token_digest').primaryKey(), digestKeyId: text('digest_key_id').notNull(), provider: text('provider').notNull(), action: text('action').notNull(), expectedHostname: text('expected_hostname').notNull(), verifiedClaimsHash: text('verified_claims_hash').notNull(), consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const riskProviderEvents = pgTable('risk_provider_events', {
  provider: text('provider').notNull(), providerEventId: text('provider_event_id').notNull(), signatureVerifiedAt: timestamp('signature_verified_at', { withTimezone: true }).notNull(), payloadRedacted: jsonb('payload_redacted').$type<Record<string, unknown>>().notNull(), status: riskProviderEventStatus('status').notNull().default('pending'), attempts: integer('attempts').notNull().default(0), nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }), processedAt: timestamp('processed_at', { withTimezone: true }), errorCode: text('error_code'),
}, (table) => [primaryKey({ columns: [table.provider, table.providerEventId] }), index('risk_provider_events_claim_idx').on(table.status, table.nextAttemptAt)])

export const policyDocuments = pgTable('policy_documents', {
  id: uuid('id').primaryKey().defaultRandom(), type: text('type').notNull(), version: text('version').notNull(), locale: text('locale').notNull(), contentRef: text('content_ref').notNull(), canonicalizationVersion: integer('canonicalization_version').notNull(), contentHash: text('content_hash').notNull(), effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(), requiresReacceptance: boolean('requires_reacceptance').notNull().default(false), retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (table) => [uniqueIndex('policy_documents_version_locale_unique').on(table.type, table.version, table.locale)])

export const policyAcceptances = pgTable('policy_acceptances', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }), subjectHash: text('subject_hash').notNull(), subjectSnapshot: jsonb('subject_snapshot').$type<Record<string, unknown>>().notNull(), policyDocumentId: uuid('policy_document_id').notNull().references(() => policyDocuments.id, { onDelete: 'restrict' }), acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(), ipPrefixHash: text('ip_prefix_hash'), userAgentFamily: text('user_agent_family'), evidenceVersion: integer('evidence_version').notNull(),
}, (table) => [index('policy_acceptances_subject_idx').on(table.subjectHash, table.acceptedAt)])

export const dataRequests = pgTable('data_requests', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }), subjectHash: text('subject_hash').notNull(), clientIdempotencyKey: text('client_idempotency_key').notNull(), requestHash: text('request_hash').notNull(), type: dataRequestType('type').notNull(), status: dataRequestStatus('status').notNull().default('submitted'), requestChannel: text('request_channel').notNull(), dueAt: timestamp('due_at', { withTimezone: true }), verifiedAt: timestamp('verified_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }), reasonCode: text('reason_code'), resultRef: text('result_ref'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('data_requests_subject_idempotency_unique').on(table.subjectHash, table.clientIdempotencyKey), index('data_requests_status_idx').on(table.status, table.createdAt)])

export const accountDeletionCases = pgTable('account_deletion_cases', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id'), subjectHash: text('subject_hash').notNull(), status: deletionCaseStatus('status').notNull().default('requested'), requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(), cancelUntil: timestamp('cancel_until', { withTimezone: true }), purgeAfter: timestamp('purge_after', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }), cancelCredentialHash: text('cancel_credential_hash'), purgeManifestRef: text('purge_manifest_ref'), purgeManifestHash: text('purge_manifest_hash'), purgeManifest: jsonb('purge_manifest').$type<Record<string, unknown>>(), failureCode: text('failure_code'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('account_deletion_cases_active_account_unique').on(table.accountId).where(sql`${table.accountId} is not null and ${table.status} in ('requested', 'cooling_off', 'scheduled', 'held', 'purging')`), uniqueIndex('account_deletion_cases_active_subject_unique').on(table.subjectHash).where(sql`${table.status} in ('requested', 'cooling_off', 'scheduled', 'held', 'purging')`)])

export const accountDeletionFences = pgTable('account_deletion_fences', {
  accountUuid: uuid('account_uuid').primaryKey(), subjectHash: text('subject_hash').notNull(), generation: uuid('generation').notNull().defaultRandom(), state: deletionFenceState('state').notNull(), holdRevision: bigint('hold_revision', { mode: 'bigint' }).notNull().default(sql`0`), blocksDomainWrites: boolean('blocks_domain_writes').notNull().default(true), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp('completed_at', { withTimezone: true }),
})

/** Legal retention is a separate approval record; it never reuses account suspension fields. */
export const legalHolds = pgTable('legal_holds', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  reasonCode: text('reason_code').notNull(),
  authority: text('authority').notNull().default('platform-admin'),
  approvedBy: uuid('approved_by').references(() => accounts.id, { onDelete: 'set null' }),
  approvedByStaffId: uuid('approved_by_staff_id').references(() => staffPrincipals.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  releasedBy: uuid('released_by').references(() => accounts.id, { onDelete: 'set null' }),
  releasedByStaffId: uuid('released_by_staff_id').references(() => staffPrincipals.id, { onDelete: 'set null' }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releaseReasonCode: text('release_reason_code'),
}, (table) => [
  uniqueIndex('legal_holds_active_account_unique').on(table.accountId).where(sql`${table.releasedAt} is null`),
  index('legal_holds_account_idx').on(table.accountId, table.approvedAt),
])

export const deletionCaseSteps = pgTable('deletion_case_steps', {
  deletionCaseId: uuid('deletion_case_id').notNull().references(() => accountDeletionCases.id, { onDelete: 'cascade' }), handler: text('handler').notNull(), state: deletionStepState('state').notNull().default('pending'), attempt: integer('attempt').notNull().default(0), idempotencyKey: text('idempotency_key').notNull(), externalRef: text('external_ref'), lastErrorCode: text('last_error_code'), completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.deletionCaseId, table.handler] })])

export const deletionLedger = pgTable('deletion_ledger', {
  subjectHash: text('subject_hash').primaryKey(), hashKeyId: text('hash_key_id').notNull(), deletionCaseId: uuid('deletion_case_id').notNull(), completedAt: timestamp('completed_at', { withTimezone: true }).notNull(), minimumBackupGeneration: bigint('minimum_backup_generation', { mode: 'bigint' }).notNull(), minimumDatabaseLsn: text('minimum_database_lsn'), receiptHash: text('receipt_hash').notNull(),
})

/** The DB row is a retryable intent, not proof that the separately held ledger received it. */
export const deletionLedgerOutbox = pgTable('deletion_ledger_outbox', {
  deletionCaseId: uuid('deletion_case_id').primaryKey().references(() => accountDeletionCases.id, { onDelete: 'restrict' }), subjectHash: text('subject_hash').notNull(), idempotencyKey: text('idempotency_key').notNull().unique(), payloadHash: text('payload_hash').notNull(), status: text('status').notNull().default('pending'), attempt: integer('attempt').notNull().default(0), nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(), deliveredAt: timestamp('delivered_at', { withTimezone: true }), externalRef: text('external_ref'), lastErrorCode: text('last_error_code'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('deletion_ledger_outbox_claim_idx').on(table.status, table.nextAttemptAt)])

/** Immutable versions only: a price or entitlement change creates another row. */
export const billingPlanVersions = pgTable('billing_plan_versions', {
  id: uuid('id').primaryKey().defaultRandom(), planKey: text('plan_key').notNull(), version: integer('version').notNull(), displayName: text('display_name').notNull(), currency: text('currency').notNull(), amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(), interval: billingPlanInterval('interval').notNull(), entitlementSchemaVersion: integer('entitlement_schema_version').notNull(), entitlements: jsonb('entitlements').$type<Record<string, unknown>>().notNull(), activeFrom: timestamp('active_from', { withTimezone: true }).notNull(), retiredAt: timestamp('retired_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('billing_plan_versions_key_version_unique').on(table.planKey, table.version), check('billing_plan_versions_amount_check', sql`${table.amountMinor} >= 0`), check('billing_plan_versions_version_check', sql`${table.version} > 0`), check('billing_plan_versions_schema_check', sql`${table.entitlementSchemaVersion} > 0`)])

export const billingPriceMappings = pgTable('billing_price_mappings', {
  id: uuid('id').primaryKey().defaultRandom(), planVersionId: uuid('plan_version_id').notNull().references(() => billingPlanVersions.id, { onDelete: 'restrict' }), provider: text('provider').notNull(), providerEnvironment: billingProviderEnvironment('provider_environment').notNull(), providerPriceId: text('provider_price_id').notNull(), currency: text('currency').notNull(), interval: billingPlanInterval('interval').notNull(), active: boolean('active').notNull().default(true), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (table) => [uniqueIndex('billing_price_mappings_provider_price_unique').on(table.provider, table.providerEnvironment, table.providerPriceId), uniqueIndex('billing_price_mappings_plan_provider_unique').on(table.planVersionId, table.provider, table.providerEnvironment, table.currency, table.interval)])

export const billingCustomers = pgTable('billing_customers', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }), subjectHash: text('subject_hash').notNull(), provider: text('provider').notNull(), providerCustomerId: text('provider_customer_id').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('billing_customers_provider_customer_unique').on(table.provider, table.providerCustomerId), uniqueIndex('billing_customers_account_unique').on(table.accountId).where(sql`${table.accountId} is not null`)])

export const accountSubscriptions = pgTable('account_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }), subjectHash: text('subject_hash').notNull(), provider: text('provider').notNull(), providerSubscriptionId: text('provider_subscription_id').notNull(), planVersionId: uuid('plan_version_id').notNull().references(() => billingPlanVersions.id, { onDelete: 'restrict' }), status: accountSubscriptionStatus('status').notNull(), isCurrent: boolean('is_current').notNull().default(false), providerRevision: text('provider_revision'), currentPeriodStart: timestamp('current_period_start', { withTimezone: true }), currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }), cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false), graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }), endedAt: timestamp('ended_at', { withTimezone: true }), snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('account_subscriptions_provider_subscription_unique').on(table.provider, table.providerSubscriptionId), uniqueIndex('account_subscriptions_current_account_unique').on(table.accountId).where(sql`${table.accountId} is not null and ${table.isCurrent}`), index('account_subscriptions_account_status_idx').on(table.accountId, table.status)])

export const entitlementGrants = pgTable('entitlement_grants', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }), source: entitlementGrantSource('source').notNull(), sourceRef: text('source_ref').notNull(), requestHash: text('request_hash').notNull(), schemaVersion: integer('schema_version').notNull(), entitlements: jsonb('entitlements').$type<Record<string, unknown>>().notNull(), priority: integer('priority').notNull(), startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp('expires_at', { withTimezone: true }), revokedAt: timestamp('revoked_at', { withTimezone: true }), reason: text('reason'), createdBy: uuid('created_by').references(() => accounts.id, { onDelete: 'set null' }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('entitlement_grants_source_unique').on(table.accountId, table.source, table.sourceRef), index('entitlement_grants_active_idx').on(table.accountId, table.startsAt, table.expiresAt), check('entitlement_grants_schema_check', sql`${table.schemaVersion} > 0`)])

export const billingWebhookEvents = pgTable('billing_webhook_events', {
  provider: text('provider').notNull(), providerEventId: text('provider_event_id').notNull(), eventType: text('event_type').notNull(), signatureVerifiedAt: timestamp('signature_verified_at', { withTimezone: true }).notNull(), receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(), payloadRedacted: jsonb('payload_redacted').$type<Record<string, unknown>>().notNull(), status: billingWebhookEventStatus('status').notNull().default('pending'), attempts: integer('attempts').notNull().default(0), nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }), errorCode: text('error_code'), processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.provider, table.providerEventId] }), index('billing_webhook_events_claim_idx').on(table.status, table.nextAttemptAt)])

export const billingCheckoutSessions = pgTable('billing_checkout_sessions', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }), provider: text('provider').notNull(), providerCheckoutId: text('provider_checkout_id'), subscriptionId: uuid('subscription_id').references(() => accountSubscriptions.id, { onDelete: 'set null' }), priceMappingId: uuid('price_mapping_id').notNull().references(() => billingPriceMappings.id, { onDelete: 'restrict' }), planVersionId: uuid('plan_version_id').notNull().references(() => billingPlanVersions.id, { onDelete: 'restrict' }), idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(), status: billingCheckoutStatus('status').notNull().default('pending_provider'), expiresAt: timestamp('expires_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('billing_checkout_sessions_account_idempotency_unique').on(table.accountId, table.idempotencyKey), uniqueIndex('billing_checkout_sessions_provider_checkout_unique').on(table.provider, table.providerCheckoutId).where(sql`${table.providerCheckoutId} is not null`), uniqueIndex('billing_checkout_sessions_active_account_unique').on(table.accountId).where(sql`${table.status} in ('pending_provider','open','completed','reconciling')`)])

export const billingAccountStates = pgTable('billing_account_states', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }), currentSubscriptionId: uuid('current_subscription_id').references(() => accountSubscriptions.id, { onDelete: 'set null' }), purchaseIntentId: uuid('purchase_intent_id').references(() => billingCheckoutSessions.id, { onDelete: 'set null' }), revision: bigint('revision', { mode: 'bigint' }).notNull().default(sql`0`), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check('billing_account_states_current_or_intent_check', sql`not (${table.currentSubscriptionId} is not null and ${table.purchaseIntentId} is not null)`)] )

export const backgroundJobs = pgTable('background_jobs', {
  id: uuid('id').primaryKey().defaultRandom(), type: text('type').notNull(), category: text('category').notNull(),
  status: backgroundJobStatus('status').notNull().default('pending'), payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  payloadVersion: integer('payload_version').notNull(), requestHash: text('request_hash').notNull(),
  queueGeneration: integer('queue_generation').notNull().default(1), minHandlerVersion: integer('min_handler_version').notNull().default(1),
  result: jsonb('result').$type<Record<string, unknown>>(), errorCode: text('error_code'), idempotencyKey: text('idempotency_key').notNull(),
  attempt: integer('attempt').notNull().default(0), maxAttempts: integer('max_attempts').notNull().default(10),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(), lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  actorAccountId: uuid('actor_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  targetAccountId: uuid('target_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), startedAt: timestamp('started_at', { withTimezone: true }), finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('background_jobs_idempotency_unique').on(table.type, table.idempotencyKey),
  index('background_jobs_claim_idx').on(table.status, table.scheduledAt),
  check('background_jobs_payload_version_check', sql`${table.payloadVersion} > 0`),
  check('background_jobs_queue_generation_check', sql`${table.queueGeneration} > 0`),
  check('background_jobs_min_handler_version_check', sql`${table.minHandlerVersion} > 0`),
  check('background_jobs_attempt_check', sql`${table.attempt} >= 0`),
  check('background_jobs_max_attempts_check', sql`${table.maxAttempts} > 0`),
])

export const outboxMessages = pgTable('outbox_messages', {
  id: uuid('id').primaryKey().defaultRandom(), channel: text('channel').notNull(), templateOrEvent: text('template_or_event').notNull(), recipientRef: text('recipient_ref').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(), payloadVersion: integer('payload_version').notNull(), secretPayloadRef: text('secret_payload_ref'),
  requestHash: text('request_hash').notNull(), idempotencyKey: text('idempotency_key').notNull(), status: outboxMessageStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), maxAttempts: integer('max_attempts').notNull().default(10), nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }), lockedBy: text('locked_by'), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  providerMessageId: text('provider_message_id'), lastErrorCode: text('last_error_code'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), sentAt: timestamp('sent_at', { withTimezone: true }),
}, (table) => [uniqueIndex('outbox_messages_idempotency_unique').on(table.channel, table.idempotencyKey), index('outbox_messages_claim_idx').on(table.status, table.nextAttemptAt)])

/** Short-lived encrypted message bodies and recipients. The durable outbox only
 * carries a non-secret reference, so operational queries and logs never need
 * to load action links or email addresses. */
export const mailSecretPayloads = pgTable('mail_secret_payloads', {
  id: uuid('id').primaryKey().defaultRandom(), keyId: text('key_id').notNull(), ciphertext: text('ciphertext').notNull(),
  payloadVersion: integer('payload_version').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  erasedAt: timestamp('erased_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('mail_secret_payloads_expiry_idx').on(table.expiresAt), check('mail_secret_payloads_version_check', sql`${table.payloadVersion} > 0`)])

/** Customer-support facts are retained independently of an account row. Message
 * bodies are versioned AEAD ciphertext; the account reference may be detached
 * by the compliance deletion handler without cascading the audit trail. */
export const supportCases = pgTable('support_cases', {
  id: uuid('id').primaryKey().defaultRandom(), accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  subjectHash: text('subject_hash').notNull(), accountSnapshot: jsonb('account_snapshot').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  category: supportCaseCategory('category').notNull(), severity: supportCaseSeverity('severity').notNull().default('normal'), status: supportCaseStatus('status').notNull().default('open'),
  subject: text('subject').notNull(), source: supportCaseSource('source').notNull(), assignedStaffId: uuid('assigned_staff_id').references(() => staffPrincipals.id, { onDelete: 'set null' }),
  assignedStaffSnapshot: jsonb('assigned_staff_snapshot').$type<Record<string, unknown>>(), lastMessageAt: timestamp('last_message_at', { withTimezone: true }), resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('support_cases_account_updated_idx').on(table.accountId, table.updatedAt), index('support_cases_queue_idx').on(table.status, table.lastMessageAt)])

/** User-consented, allowlisted diagnostic summaries. The snapshot is always
 * encrypted and may be deleted without deleting its minimal authorization fact. */
export const supportDiagnosticGrants = pgTable('support_diagnostic_grants', {
  id: uuid('id').primaryKey().defaultRandom(), caseId: uuid('case_id').notNull().references(() => supportCases.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }), scopeVersion: text('scope_version').notNull(),
  snapshotCiphertext: text('snapshot_ciphertext').notNull(), snapshotKeyId: text('snapshot_key_id').notNull(), snapshotEncryptionVersion: integer('snapshot_encryption_version').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), revokedAt: timestamp('revoked_at', { withTimezone: true }), deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('support_diagnostic_grants_case_idx').on(table.caseId, table.expiresAt), index('support_diagnostic_grants_account_idx').on(table.accountId, table.expiresAt), check('support_diagnostic_grants_scope_check', sql`length(${table.scopeVersion}) > 0`), check('support_diagnostic_grants_encryption_version_check', sql`${table.snapshotEncryptionVersion} > 0`)])

export const supportMessages = pgTable('support_messages', {
  id: uuid('id').primaryKey().defaultRandom(), caseId: uuid('case_id').notNull().references(() => supportCases.id, { onDelete: 'restrict' }), authorType: supportMessageAuthorType('author_type').notNull(), authorRef: text('author_ref'), authorSnapshot: jsonb('author_snapshot').$type<Record<string, unknown>>(),
  visibility: supportMessageVisibility('visibility').notNull().default('customer'), bodyCiphertext: text('body_ciphertext').notNull(), bodyKeyId: text('body_key_id').notNull(), bodyEncryptionVersion: integer('body_encryption_version').notNull(), bodyFormat: text('body_format').notNull().default('plain'),
  idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('support_messages_case_author_idempotency_unique').on(table.caseId, table.authorType, table.idempotencyKey),
  index('support_messages_case_created_idx').on(table.caseId, table.createdAt),
  check('support_messages_encryption_version_check', sql`${table.bodyEncryptionVersion} > 0`),
  check('support_messages_key_id_check', sql`length(${table.bodyKeyId}) > 0`),
])

export const bootstrapCredentials = pgTable('bootstrap_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: bootstrapCredentialSource('source').notNull(), tokenKeyId: text('token_key_id').notNull(),
  tokenHash: text('token_hash').notNull(), tokenHint: text('token_hint').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('bootstrap_credentials_token_hash_unique').on(table.tokenHash), index('bootstrap_credentials_active_idx').on(table.expiresAt)])

export const registrationInvitations = pgTable('registration_invitations', {
  id: uuid('id').primaryKey().defaultRandom(), tokenKeyId: text('token_key_id').notNull(), tokenHash: text('token_hash').notNull(), tokenHint: text('token_hint').notNull(),
  createdByActorType: invitationActorType('created_by_actor_type').notNull(), createdByActorId: uuid('created_by_actor_id'), creatorSnapshot: jsonb('creator_snapshot').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  boundEmailNormalized: text('bound_email_normalized'), maxUses: integer('max_uses').notNull().default(1), useCount: integer('use_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), revokedAt: timestamp('revoked_at', { withTimezone: true }), lastSentAt: timestamp('last_sent_at', { withTimezone: true }), note: text('note'),
  replacesInvitationId: uuid('replaces_invitation_id'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('registration_invitations_token_hash_unique').on(table.tokenHash), index('registration_invitations_active_idx').on(table.expiresAt), check('registration_invitations_use_count_check', sql`${table.maxUses} > 0 and ${table.useCount} >= 0 and ${table.useCount} <= ${table.maxUses}`)])

export const registrationInvitationUses = pgTable('registration_invitation_uses', {
  id: uuid('id').primaryKey().defaultRandom(), invitationId: uuid('invitation_id').notNull().references(() => registrationInvitations.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }), requestId: text('request_id').notNull(), usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('registration_invitation_uses_account_unique').on(table.invitationId, table.accountId), index('registration_invitation_uses_invitation_idx').on(table.invitationId, table.usedAt)])

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

/** Cross-realm append-only audit facts. actorId is deliberately a stable text
 * snapshot so account/staff deletion never erases the causal record. */
export const accountServiceAuditEvents = pgTable('account_service_audit_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), actorType: text('actor_type').notNull(), actorId: text('actor_id'),
  action: text('action').notNull(), targetType: text('target_type').notNull(), targetId: text('target_id'), requestId: text('request_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('account_service_audit_events_actor_idx').on(table.actorType, table.actorId, table.occurredAt),
  index('account_service_audit_events_target_idx').on(table.targetType, table.targetId, table.occurredAt),
  check('account_service_audit_events_actor_type_check', sql`${table.actorType} in ('account', 'staff', 'system', 'webhook')`),
  check('account_service_audit_events_action_check', sql`length(${table.action}) > 0`),
  check('account_service_audit_events_target_type_check', sql`length(${table.targetType}) > 0`),
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
  issuedInstanceAuthEpoch: bigint('issued_instance_auth_epoch', { mode: 'bigint' }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  rotationRequestId: uuid('rotation_request_id'), rotationResponseCiphertext: text('rotation_response_ciphertext'), rotationResponseExpiresAt: timestamp('rotation_response_expires_at', { withTimezone: true }),
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
  issuedInstanceAuthEpoch: bigint('issued_instance_auth_epoch', { mode: 'bigint' }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
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
  approvedCredentialEpoch: bigint('approved_credential_epoch', { mode: 'bigint' }),
  approvedInstanceAuthEpoch: bigint('approved_instance_auth_epoch', { mode: 'bigint' }),
  approvedIssuedAt: timestamp('approved_issued_at', { withTimezone: true }),
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
  credentialEpoch: bigint('credential_epoch', { mode: 'bigint' }),
  instanceAuthEpoch: bigint('instance_auth_epoch', { mode: 'bigint' }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
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
  creationIdempotencyKey: text('creation_idempotency_key'),
  creationRequestHash: text('creation_request_hash'),
  isDefault: boolean('is_default').notNull().default(false),
  latestSequence: bigint('latest_sequence', { mode: 'bigint' }).notNull().default(sql`0`),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index('workspaces_account_idx').on(table.accountId),
  uniqueIndex('workspaces_active_default_unique')
    .on(table.accountId)
    .where(sql`${table.isDefault} = true and ${table.deletedAt} is null`),
  uniqueIndex('workspaces_account_creation_idempotency_unique')
    .on(table.accountId, table.creationIdempotencyKey)
    .where(sql`${table.creationIdempotencyKey} is not null`),
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
  status: keyEnvelopeStatus('status').notNull().default('active'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  replacementIdempotencyKey: text('replacement_idempotency_key'),
  replacementRequestHash: text('replacement_request_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('workspace_key_envelopes_key_idx').on(table.workspaceId, table.keyVersion),
  uniqueIndex('workspace_key_envelopes_active_recipient_unique').on(
    table.workspaceId, table.keyVersion, table.type, sql`coalesce(${table.recipientId}, '')`,
  ).where(sql`${table.status} = 'active'`),
  uniqueIndex('workspace_key_envelopes_replacement_idempotency_unique').on(
    table.workspaceId, table.keyVersion, table.replacementIdempotencyKey,
  ).where(sql`${table.replacementIdempotencyKey} is not null`),
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
  usageReservationId: uuid('usage_reservation_id').references(() => usageReservations.id, { onDelete: 'set null' }),
  /** Bound at upload creation; restore rejects a bound upload from an old epoch. */
  syncEpoch: uuid('sync_epoch'),
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
  uniqueIndex('blob_uploads_usage_reservation_unique').on(table.usageReservationId).where(sql`${table.usageReservationId} is not null`),
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
