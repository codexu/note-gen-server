import { createHash } from 'node:crypto'
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import {
  blobUploads, bootstrapSessions, deviceAuthorizations, devicePairings,
  stepUpGrants, supportDiagnosticGrants, syncBootstrapSessions, syncDeviceCursors,
  webSessions, workspaces,
} from '../database/schema.js'
import type { BlobStorage } from '../storage/blob-storage.js'
import { BLOB_COMPLETION_LEASE_MS } from '../blobs/constants.js'
import type { MaintenanceCoordinator } from './coordinator.js'
import type { UsageService } from '../usage/service.js'
import type { DeletionLedgerStore } from '../compliance/deletion-ledger-store.js'

export interface MaintenanceResult {
  skipped: boolean
  bootstrapSessions: number
  syncBootstrapSessions: number
  deviceAuthorizations: number
  devicePairings: number
  webSessions: number
  stepUpGrants: number
  expiredMailPayloads: number
  completedUploads: number
  accounts: number
  expiredUploads: number
  workspaces: number
  changes: number
  versions: number
  operations: number
  syncEvents: number
  syncCommands: number
  syncCheckpoints: number
  syncConflicts: number
  syncDeviceCursors: number
  tombstones: number
  blobs: number
  deletionCases: number
  deletionLedgerDeliveries: number
}

export class MaintenanceService {
  #timer: NodeJS.Timeout | undefined
  #running = false

  constructor(
    private readonly database: DatabaseContext,
    private readonly storage: BlobStorage,
    private readonly config: AppConfig,
    private readonly coordinator?: MaintenanceCoordinator,
    private readonly usage?: UsageService,
    private readonly deletionLedger?: DeletionLedgerStore,
  ) {}

  start(
    intervalMs = 60 * 60 * 1000,
    onError: (error: unknown) => void = (error) => console.error('Maintenance failed', error),
  ): () => void {
    if (this.#timer !== undefined) return () => this.stop()
    this.#timer = setInterval(() => void this.runOnce().catch(onError), intervalMs)
    this.#timer.unref()
    // A restart must not defer expiration recovery for a whole maintenance
    // interval. The advisory lock and #running fence keep this safe when
    // several instances become ready at the same time.
    void this.runOnce().catch(onError)
    return () => this.stop()
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async runOnce(): Promise<MaintenanceResult> {
    if (this.coordinator !== undefined && (await this.coordinator.getSnapshot()).mode !== 'normal') return emptyMaintenanceResult()
    if (this.#running) return emptyMaintenanceResult()
    this.#running = true
    let connection: Awaited<ReturnType<DatabaseContext['sql']['reserve']>> | undefined
    try {
      connection = await this.database.sql.reserve()
      const [lock] = await connection<Array<{ acquired: boolean }>>`
        select pg_try_advisory_lock(hashtext('notegen-maintenance')) as acquired`
      if (!lock?.acquired) return emptyMaintenanceResult()
      return await this.#runOnceLocked()
    } finally {
      if (connection !== undefined) {
        await connection`select pg_advisory_unlock(hashtext('notegen-maintenance'))`.catch(() => undefined)
        connection.release()
      }
      this.#running = false
    }
  }

  async #runOnceLocked(): Promise<MaintenanceResult> {
    const removedBootstrapSessions = await this.database.db.delete(bootstrapSessions)
      .where(lt(bootstrapSessions.expiresAt, new Date()))
      .returning({ id: bootstrapSessions.id })
    const removedSyncBootstrapSessions = await this.database.db.delete(syncBootstrapSessions)
      .where(lt(syncBootstrapSessions.expiresAt, new Date()))
      .returning({ id: syncBootstrapSessions.id })
    const removedDeviceAuthorizations = await this.database.db.delete(deviceAuthorizations)
      .where(lt(deviceAuthorizations.expiresAt, new Date()))
      .returning({ id: deviceAuthorizations.id })
    const removedDevicePairings = await this.database.db.delete(devicePairings)
      .where(lt(devicePairings.expiresAt, new Date()))
      .returning({ id: devicePairings.id })
    const removedWebSessions = await this.database.db.delete(webSessions)
      .where(lt(webSessions.expiresAt, new Date()))
      .returning({ id: webSessions.id })
    const removedStepUpGrants = await this.database.db.delete(stepUpGrants)
      .where(or(
        lt(stepUpGrants.expiresAt, new Date()),
        lt(stepUpGrants.consumedAt, daysAgo(7)),
        lt(stepUpGrants.revokedAt, daysAgo(7)),
      ))
      .returning({ id: stepUpGrants.id })
    // Action tokens are bearer credentials. Once expired they have no audit or
    // recovery value in this internal-test implementation and must not remain
    // as indefinitely queryable credential material.
    await this.database.sql`delete from account_action_tokens where expires_at < now()`
    // The secret envelope is deliberately shorter lived than any audit fact.
    // Once its action token expires, remove the ciphertext and terminally
    // cancel its unsent outbox intent so a future worker cannot revive it.
    const expiredMailPayloads = await this.database.sql<Array<{ id: string }>>`
      update mail_secret_payloads
      set erased_at = now(), ciphertext = ''
      where expires_at < now() and erased_at is null
      returning id`
    if (expiredMailPayloads.length > 0) {
      await this.database.sql`
        update outbox_messages
        set status = 'dead_letter', last_error_code = 'secret_payload_expired',
            locked_at = null, locked_by = null, lease_expires_at = null
        where channel = 'mail' and secret_payload_ref = any(${this.database.sql.array(expiredMailPayloads.map(row => row.id))}::uuid[])
          and status in ('pending', 'sending')`
    }
    // Pending email registrations never receive a device or Workspace. Prune
    // abandoned records after a conservative internal-test window, deleting
    // the claim first because it intentionally has a restrictive account FK.
    const removedPendingAccounts = await this.database.sql.begin(async (sql) => {
      const candidates = await sql<Array<{ id: string }>>`
        select a.id from accounts a
        where a.identity_state = 'pending_verification'
          and a.created_at < ${daysAgo(this.config.pendingEmailVerificationDays).toISOString()}::timestamptz
          and not exists (select 1 from devices d where d.account_id = a.id)
          and not exists (select 1 from workspaces w where w.account_id = a.id)
        for update skip locked`
      if (candidates.length === 0) return 0
      const ids = candidates.map(candidate => candidate.id)
      await sql`delete from account_login_claims where account_id = any(${sql.array(ids)}::uuid[])`
      const deleted = await sql<Array<{ id: string }>>`
        delete from accounts where id = any(${sql.array(ids)}::uuid[]) and identity_state = 'pending_verification'
        returning id`
      return deleted.length
    })
    await this.database.sql`delete from rate_limit_buckets where expires_at < now()`
    // Retain the minimal grant fact for audit, but irreversibly erase the
    // encrypted snapshot after expiry or user revocation. The predicate makes
    // this safe to rerun after a crash.
    await this.database.db.update(supportDiagnosticGrants).set({ snapshotCiphertext: '', deletedAt: new Date() })
      .where(and(sql`${supportDiagnosticGrants.deletedAt} is null`, or(sql`${supportDiagnosticGrants.revokedAt} is not null`, lt(supportDiagnosticGrants.expiresAt, new Date()))))
    const removedCompletedUploads = await this.database.db.delete(blobUploads).where(and(
      lt(blobUploads.completedAt, daysAgo(7)),
    )).returning({ id: blobUploads.id })
    const expiredUploads = await this.#cleanupUploads()
    const advancedDeletionCases = await this.#advanceDeletionCases()
    const changeCutoff = daysAgo(this.config.changeRetentionDays)
    const versionCutoff = daysAgo(this.config.versionRetentionDays)
    const tombstoneCutoff = daysAgo(this.config.tombstoneRetentionDays)
    const removedWorkspaces = await this.#cleanupDeletedWorkspaces(tombstoneCutoff)
    const purgingDeletionCases = await this.#startScheduledDeletionPurges(tombstoneCutoff)
    const finalizedDeletionAccounts = await this.#finalizePurgingDeletionAccounts(tombstoneCutoff)
    const deliveredDeletionLedger = await this.#deliverDeletionLedger()
    const removedAccounts = await this.database.sql<Array<{ id: string }>>`
      delete from accounts a
      where a.disabled_at is not null
        and a.disabled_at < ${tombstoneCutoff.toISOString()}::timestamptz
        and not exists (select 1 from workspaces w where w.account_id = a.id)
        and not exists (select 1 from account_deletion_cases c where c.account_id = a.id)
      returning a.id`
    const [changesResult, versionsResult, operationsResult, syncEventsResult, syncCommandsResult,
      syncCheckpointsResult, syncConflictsResult, tombstonesResult, blobsResult] =
      await this.database.sql.begin(async (sql) => {
        const removedChanges = await sql`
          delete from changes where id in (
            select id from changes where created_at < ${changeCutoff.toISOString()}::timestamptz order by id limit 10000
          ) returning id`
        const removedVersions = await sql`
          delete from object_versions v where (v.workspace_id, v.object_id, v.revision) in (
            select version_row.workspace_id, version_row.object_id, version_row.revision
            from object_versions version_row
            left join objects o on o.workspace_id = version_row.workspace_id and o.object_id = version_row.object_id
            where version_row.created_at < ${versionCutoff.toISOString()}::timestamptz
              and (o.object_id is null or version_row.revision <> o.current_revision)
              and not exists (
                select 1 from changes c
                where c.workspace_id = version_row.workspace_id
                  and c.object_id = version_row.object_id
                  and c.revision = version_row.revision
              )
              and not exists (
                select 1 from bootstrap_sessions s
                where s.workspace_id = version_row.workspace_id
                  and s.expires_at > now()
                  and version_row.sequence <= s.snapshot_sequence
              )
              and not exists (
                select 1 from sync_bootstrap_objects bo
                join sync_bootstrap_sessions bs on bs.id = bo.session_id
                where bo.workspace_id = version_row.workspace_id
                  and bo.object_id = version_row.object_id
                  and bo.revision = version_row.revision
                  and bs.expires_at > now()
              )
              and not exists (
                select 1 from sync_resource_bindings rb
                where rb.workspace_id = version_row.workspace_id
                  and rb.resource_object_id = version_row.object_id
                  and rb.resource_revision = version_row.revision
              )
            limit 5000
          ) returning revision`
        const removedOperations = await sql`
          delete from operations where (workspace_id, operation_id) in (
            select workspace_id, operation_id from operations
            where created_at < ${changeCutoff.toISOString()}::timestamptz limit 10000
          ) returning operation_id`
        const removedSyncEvents = await sql`
          delete from sync_events where id in (
            select id from sync_events
            where created_at < ${changeCutoff.toISOString()}::timestamptz
            order by id limit 10000
          ) returning id`
        const removedSyncCommands = await sql`
          delete from sync_commands where (workspace_id, command_id) in (
            select workspace_id, command_id from sync_commands
            where created_at < ${changeCutoff.toISOString()}::timestamptz
            order by created_at limit 10000
          ) returning command_id`
        const removedSyncCheckpoints = await sql`
          delete from sync_checkpoints checkpoint where (workspace_id, checkpoint_id) in (
            select candidate.workspace_id, candidate.checkpoint_id
            from sync_checkpoints candidate
            left join sync_documents document
              on document.workspace_id = candidate.workspace_id
              and document.checkpoint_id = candidate.checkpoint_id
            where candidate.created_at < ${versionCutoff.toISOString()}::timestamptz
              and document.checkpoint_id is null
              and not exists (
                select 1 from sync_bootstrap_objects snapshot
                join sync_bootstrap_sessions session on session.id = snapshot.session_id
                where snapshot.workspace_id = candidate.workspace_id
                  and snapshot.checkpoint_id = candidate.checkpoint_id
                  and session.expires_at > now()
              )
            order by candidate.created_at limit 5000
          ) returning checkpoint_id`
        const removedSyncConflicts = await sql`
          delete from sync_conflicts where (workspace_id, conflict_id) in (
            select workspace_id, conflict_id from sync_conflicts
            where status = 'resolved' and resolved_at < ${changeCutoff.toISOString()}::timestamptz
            order by resolved_at limit 5000
          ) returning conflict_id`
        const removedTombstones = await sql`
          delete from objects where (workspace_id, object_id) in (
            select workspace_id, object_id from objects
            where deleted_at is not null and deleted_at < ${tombstoneCutoff.toISOString()}::timestamptz limit 5000
          ) returning object_id`
        const candidates = await sql<Array<{ workspace_id: string, blob_id: string, storage_key: string }>>`
          select b.workspace_id, b.blob_id, b.storage_key
          from blobs b
          where b.state = 'ready'
            and coalesce(b.last_referenced_at, b.created_at) < ${versionCutoff.toISOString()}::timestamptz
            and not exists (
              select 1 from objects o
              where o.workspace_id = b.workspace_id and o.blob_refs ? b.blob_id
            )
            and not exists (
              select 1 from object_versions v
              where v.workspace_id = b.workspace_id and v.blob_refs ? b.blob_id
            )
          limit 1000`
        return [removedChanges, removedVersions, removedOperations, removedSyncEvents,
          removedSyncCommands, removedSyncCheckpoints, removedSyncConflicts,
          removedTombstones, candidates] as const
      })

    const removedSyncDeviceCursors = await this.database.db.delete(syncDeviceCursors)
      .where(lt(syncDeviceCursors.updatedAt, changeCutoff))
      .returning({ deviceId: syncDeviceCursors.deviceId })

    let removedBlobs = 0
    for (const blob of blobsResult) {
      await this.storage.delete(blob.storage_key)
      await this.database.sql`
        delete from blobs where workspace_id = ${blob.workspace_id} and blob_id = ${blob.blob_id}`
      removedBlobs += 1
    }

    return {
      skipped: false,
      bootstrapSessions: removedBootstrapSessions.length,
      syncBootstrapSessions: removedSyncBootstrapSessions.length,
      deviceAuthorizations: removedDeviceAuthorizations.length,
      devicePairings: removedDevicePairings.length,
      webSessions: removedWebSessions.length,
      stepUpGrants: removedStepUpGrants.length,
      expiredMailPayloads: expiredMailPayloads.length,
      completedUploads: removedCompletedUploads.length,
      accounts: removedPendingAccounts + removedAccounts.length + finalizedDeletionAccounts,
      expiredUploads,
      workspaces: removedWorkspaces,
      changes: changesResult.length,
      versions: versionsResult.length,
      operations: operationsResult.length,
      syncEvents: syncEventsResult.length,
      syncCommands: syncCommandsResult.length,
      syncCheckpoints: syncCheckpointsResult.length,
      syncConflicts: syncConflictsResult.length,
      syncDeviceCursors: removedSyncDeviceCursors.length,
      tombstones: tombstonesResult.length,
      blobs: removedBlobs,
      deletionCases: advancedDeletionCases + purgingDeletionCases + finalizedDeletionAccounts,
      deletionLedgerDeliveries: deliveredDeletionLedger,
    }
  }

  async #cleanupUploads(): Promise<number> {
    const staleCompletion = new Date(Date.now() - BLOB_COMPLETION_LEASE_MS)
    const expired = await this.database.db.select().from(blobUploads).where(and(
      isNull(blobUploads.completedAt), lt(blobUploads.expiresAt, new Date()),
      or(isNull(blobUploads.completingAt), lt(blobUploads.completingAt, staleCompletion)),
    )).orderBy(asc(blobUploads.expiresAt)).limit(100)
    let removed = 0
    for (const upload of expired) {
      await this.storage.abortUpload(upload.storageKey, upload.providerUploadId).catch(() => undefined)
      const [deletedUpload] = await this.database.db.delete(blobUploads).where(eq(blobUploads.id, upload.id))
        .returning({ id: blobUploads.id })
      if (deletedUpload !== undefined && upload.usageReservationId !== null) await this.usage?.releaseReservation(upload.usageReservationId)
      await this.database.sql`
        delete from blobs b
        where b.workspace_id = ${upload.workspaceId}
          and b.blob_id = ${upload.blobId}
          and b.state = 'uploading'
          and not exists (
            select 1 from blob_uploads u
            where u.workspace_id = b.workspace_id and u.blob_id = b.blob_id
              and u.completed_at is null and u.expires_at > now()
          )`
      removed += 1
    }
    return removed
  }

  /** Turns elapsed cooling-off cases into durable scheduled work; a hold wins every time. */
  async #advanceDeletionCases(): Promise<number> {
    const candidates = await this.database.sql<Array<{ id: string, account_id: string }>>`
      select id, account_id from account_deletion_cases
      where status in ('cooling_off', 'held') and account_id is not null
        and purge_after is not null and purge_after <= now()
      order by purge_after asc, id asc limit 20`
    let advanced = 0
    for (const candidate of candidates) {
      const changed = await this.database.sql.begin(async (tx) => {
        // Legal-hold placement/release and every destructive deletion step
        // share this subject lock. Re-read after taking it; the optimistic
        // candidate query above is intentionally not a decision point.
        await tx`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${candidate.account_id}`}))`
        const [caseRow] = await tx<Array<{ status: string }>>`
          select status from account_deletion_cases
          where id = ${candidate.id} and account_id = ${candidate.account_id}
            and status in ('cooling_off', 'held')
            and purge_after is not null and purge_after <= now()
          for update`
        if (caseRow === undefined) return false
        const [hold] = await tx<Array<{ id: string }>>`
          select id from legal_holds where account_id = ${candidate.account_id}
            and released_at is null limit 1`
        const nextStatus = hold === undefined ? 'scheduled' : 'held'
        if (caseRow.status === nextStatus) return false
        const [updated] = await tx<Array<{ id: string }>>`
          update account_deletion_cases set status = ${nextStatus}::deletion_case_status
          where id = ${candidate.id} and status in ('cooling_off', 'held')
          returning id`
        if (updated === undefined) return false
        if (nextStatus === 'scheduled') {
          await tx`
            update account_deletion_fences set state = 'scheduled', updated_at = now()
            where account_uuid = ${candidate.account_id} and blocks_domain_writes = true`
        }
        return true
      })
      if (changed) advanced += 1
    }
    return advanced
  }

  /** Claims a fully-cleaned case before its account identity is destroyed.
   * This is a separate durable transition so an interruption is recoverable
   * from `purging`, rather than looking like a fresh scheduled case. */
  async #startScheduledDeletionPurges(cutoff: Date): Promise<number> {
    const candidates = await this.database.sql<Array<{ account_id: string, case_id: string, subject_hash: string }>>`
      select a.id as account_id, c.id as case_id, c.subject_hash
      from accounts a join account_deletion_cases c on c.account_id = a.id
      where a.disabled_at is not null
        and (a.disabled_at < ${cutoff.toISOString()}::timestamptz or (c.purge_after is not null and c.purge_after <= now()))
        and c.status = 'scheduled'
        and not exists (select 1 from workspaces w where w.account_id = a.id)
        and not exists (select 1 from legal_holds h where h.account_id = a.id and h.released_at is null)
      order by a.disabled_at asc limit 20`
    let claimed = 0
    for (const candidate of candidates) {
      const didClaim = await this.database.sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${candidate.account_id}`}))`
        const [activeHold] = await tx<Array<{ id: string }>>`
          select id from legal_holds where account_id = ${candidate.account_id}
            and released_at is null limit 1`
        if (activeHold !== undefined) return false
        const [eligible] = await tx<Array<{ id: string }>>`
          select a.id from accounts a join account_deletion_cases c on c.account_id = a.id
          where a.id = ${candidate.account_id} and a.disabled_at is not null
            and c.id = ${candidate.case_id} and c.status = 'scheduled'
            and not exists (select 1 from workspaces w where w.account_id = a.id)
          for update`
        if (eligible === undefined) return false
        const startedAt = new Date()
        await tx`
          insert into deletion_case_steps (deletion_case_id, handler, idempotency_key)
          values
            (${candidate.case_id}, 'workspace_blob', ${`${candidate.case_id}:v1:workspace_blob`}),
            (${candidate.case_id}, 'support_content', ${`${candidate.case_id}:v1:support_content`}),
            (${candidate.case_id}, 'identity', ${`${candidate.case_id}:v1:identity`})
          on conflict (deletion_case_id, handler) do nothing`
        await tx`
          update deletion_case_steps set state = 'completed', attempt = attempt + 1,
            completed_at = ${startedAt.toISOString()}::timestamptz, last_error_code = null
          where deletion_case_id = ${candidate.case_id} and handler = 'workspace_blob'
            and state in ('pending', 'running', 'failed')`
        const [transitioned] = await tx<Array<{ id: string }>>`
          update account_deletion_cases set status = 'purging'
          where id = ${candidate.case_id} and status = 'scheduled'
          returning id`
        if (transitioned === undefined) return false
        await tx`
          update account_deletion_fences set state = 'purging', updated_at = ${startedAt.toISOString()}::timestamptz
          where account_uuid = ${candidate.account_id} and blocks_domain_writes = true`
        return true
      })
      if (didClaim) claimed += 1
    }
    return claimed
  }

  /** Finalizes only purging, unheld cases after the purge manifest is durable. */
  async #finalizePurgingDeletionAccounts(cutoff: Date): Promise<number> {
    const candidates = await this.database.sql<Array<{ account_id: string, case_id: string, subject_hash: string }>>`
      select a.id as account_id, c.id as case_id, c.subject_hash
      from accounts a join account_deletion_cases c on c.account_id = a.id
      where a.disabled_at is not null
        and (a.disabled_at < ${cutoff.toISOString()}::timestamptz or (c.purge_after is not null and c.purge_after <= now()))
        and c.status = 'purging'
        and not exists (select 1 from workspaces w where w.account_id = a.id)
        and not exists (select 1 from legal_holds h where h.account_id = a.id and h.released_at is null)
      order by a.disabled_at asc limit 20`
    let completed = 0
    for (const candidate of candidates) {
      const completedAt = new Date()
      const receiptHash = createHash('sha256').update(`${candidate.subject_hash}:${candidate.case_id}:${completedAt.toISOString()}`).digest('base64url')
      const didDelete = await this.database.sql.begin(async (tx) => {
        // This lock is shared with legal-hold mutations and cooling-off
        // transitions. The following delete predicates are therefore a
        // decision made after the final hold check, not a stale preselection.
        await tx`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${candidate.account_id}`}))`
        const [activeHold] = await tx<Array<{ id: string }>>`
          select id from legal_holds where account_id = ${candidate.account_id}
            and released_at is null limit 1`
        if (activeHold !== undefined) return false
        const [eligible] = await tx<Array<{ id: string }>>`
          select a.id from accounts a join account_deletion_cases c on c.account_id = a.id
          where a.id = ${candidate.account_id} and a.disabled_at is not null
            and c.id = ${candidate.case_id} and c.status = 'purging'
            and not exists (select 1 from workspaces w where w.account_id = a.id)
          for update`
        if (eligible === undefined) return false
        const manifest = {
          version: 1, deletionCaseId: candidate.case_id, subjectHash: candidate.subject_hash,
          preparedAt: completedAt.toISOString(), handlers: ['workspace_blob', 'support_content', 'identity'],
        }
        const manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('base64url')
        await tx`
          update account_deletion_cases
          set purge_manifest = ${tx.json(manifest)}::jsonb,
              purge_manifest_ref = ${`db://account-deletion-cases/${candidate.case_id}/purge-manifest`},
              purge_manifest_hash = ${manifestHash}
          where id = ${candidate.case_id} and status = 'purging'`
        // Support facts may be retained for a controlled operational record,
        // but customer message bodies and identity snapshots are not needed
        // once the deletion case has reached its terminal handler.
        await tx`
          update support_diagnostic_grants set revoked_at = ${completedAt.toISOString()}::timestamptz,
            deleted_at = ${completedAt.toISOString()}::timestamptz, snapshot_ciphertext = ''
          where account_id = ${candidate.account_id} and deleted_at is null`
        await tx`
          delete from support_messages message using support_cases support_case
          where message.case_id = support_case.id and support_case.account_id = ${candidate.account_id}`
        await tx`
          update support_cases set account_id = null, account_snapshot = '{}'::jsonb,
            subject = 'Deleted account support case', updated_at = ${completedAt.toISOString()}::timestamptz
          where account_id = ${candidate.account_id}`
        await tx`
          update deletion_case_steps set state = 'completed', attempt = attempt + 1,
            completed_at = ${completedAt.toISOString()}::timestamptz, last_error_code = null
          where deletion_case_id = ${candidate.case_id} and handler = 'support_content'
            and state in ('pending', 'running', 'failed')`
        const [deleted] = await tx<Array<{ id: string }>>`
          delete from accounts a where a.id = ${candidate.account_id}
            and a.disabled_at is not null
            and not exists (select 1 from workspaces w where w.account_id = a.id)
            and not exists (select 1 from legal_holds h where h.account_id = a.id and h.released_at is null)
          returning a.id`
        if (deleted === undefined) return false
        await tx`
          update deletion_case_steps set state = 'completed', attempt = attempt + 1,
            completed_at = ${completedAt.toISOString()}::timestamptz, last_error_code = null
          where deletion_case_id = ${candidate.case_id} and handler = 'identity'
            and state in ('pending', 'running', 'failed')`
        // A backup created before this deletion cannot prove the subject is
        // absent. The next ready backup generation must include this ledger
        // record before it becomes a post-deletion restore baseline.
        const [backup] = await tx<Array<{ generation: string }>>`
          select coalesce(max(generation), 0)::text as generation from backup_runs where status = 'ready'`
        const minimumBackupGeneration = (BigInt(backup?.generation ?? '0') + 1n).toString()
        await tx`
          insert into deletion_ledger (subject_hash, hash_key_id, deletion_case_id, completed_at, minimum_backup_generation, minimum_database_lsn, receipt_hash)
          values (${candidate.subject_hash}, 'auth-secret-v1', ${candidate.case_id}, ${completedAt.toISOString()}::timestamptz, ${minimumBackupGeneration}::bigint, pg_current_wal_lsn()::text, ${receiptHash})
          on conflict (subject_hash) do nothing`
        const outboxPayloadHash = createHash('sha256').update(JSON.stringify({ subjectHash: candidate.subject_hash, deletionCaseId: candidate.case_id, completedAt: completedAt.toISOString(), minimumBackupGeneration, receiptHash })).digest('base64url')
        await tx`
          insert into deletion_ledger_outbox (deletion_case_id, subject_hash, idempotency_key, payload_hash)
          values (${candidate.case_id}, ${candidate.subject_hash}, ${`${candidate.case_id}:v1:deletion-ledger`}, ${outboxPayloadHash})
          on conflict (deletion_case_id) do nothing`
        const [existingReceipt] = await tx<Array<{ status: string }>>`select status from deletion_ledger_outbox where deletion_case_id = ${candidate.case_id} for update`
        if (existingReceipt?.status === 'delivered') {
          await tx`update account_deletion_cases set status = 'completed', completed_at = ${completedAt.toISOString()}::timestamptz, account_id = null where id = ${candidate.case_id}`
          await tx`update account_deletion_fences set state = 'completed', completed_at = ${completedAt.toISOString()}::timestamptz, updated_at = ${completedAt.toISOString()}::timestamptz where account_uuid = ${candidate.account_id}`
        } else {
          // The account is now removed, but the case/fence remain purging until
          // the separately held ledger receipt has acknowledged the intent.
          await tx`update account_deletion_cases set account_id = null where id = ${candidate.case_id}`
        }
        return true
      })
      if (didDelete) completed += 1
    }
    return completed
  }

  /** Replays durable deletion intents into the separate receipt store, then
   * atomically turns the local case/fence terminal. The store is idempotent,
   * so a crash between its write and this update is harmless. */
  async #deliverDeletionLedger(): Promise<number> {
    if (this.deletionLedger === undefined) return 0
    const candidates = await this.database.sql<Array<{ deletion_case_id: string, subject_hash: string, idempotency_key: string, payload_hash: string, completed_at: string, minimum_backup_generation: string, minimum_database_lsn: string | null, receipt_hash: string }>>`
      select o.deletion_case_id, o.subject_hash, o.idempotency_key, o.payload_hash,
        l.completed_at::text, l.minimum_backup_generation::text, l.minimum_database_lsn, l.receipt_hash
      from deletion_ledger_outbox o join deletion_ledger l on l.deletion_case_id = o.deletion_case_id
      where o.status = 'pending' and o.next_attempt_at <= now()
      order by o.created_at asc limit 20`
    let delivered = 0
    for (const candidate of candidates) {
      try {
        const receipt = await this.deletionLedger.deliver({
          deletionCaseId: candidate.deletion_case_id, subjectHash: candidate.subject_hash, completedAt: new Date(candidate.completed_at).toISOString(),
          minimumBackupGeneration: candidate.minimum_backup_generation, minimumDatabaseLsn: candidate.minimum_database_lsn, receiptHash: candidate.receipt_hash,
        }, candidate.idempotency_key)
        const changed = await this.database.sql.begin(async (tx) => {
          const [outbox] = await tx<Array<{ deletion_case_id: string }>>`
            update deletion_ledger_outbox set status = 'delivered', attempt = attempt + 1, delivered_at = now(), external_ref = ${receipt.externalRef}, last_error_code = null
            where deletion_case_id = ${candidate.deletion_case_id} and status = 'pending'
            returning deletion_case_id`
          if (outbox === undefined) return false
          const [caseRow] = await tx<Array<{ id: string }>>`
            update account_deletion_cases set status = 'completed', completed_at = l.completed_at
            from deletion_ledger l where account_deletion_cases.id = ${candidate.deletion_case_id}
              and l.deletion_case_id = account_deletion_cases.id and account_deletion_cases.status = 'purging'
            returning account_deletion_cases.id`
          if (caseRow === undefined) throw new Error('Deletion ledger case is not purging')
          await tx`update account_deletion_fences set state = 'completed', completed_at = l.completed_at, updated_at = now()
            from deletion_ledger l where l.deletion_case_id = ${candidate.deletion_case_id}
              and account_deletion_fences.subject_hash = l.subject_hash`
          return true
        })
        if (changed) delivered += 1
      } catch (error: unknown) {
        const retryAt = new Date(Date.now() + 60_000)
        await this.database.sql`update deletion_ledger_outbox set attempt = attempt + 1, next_attempt_at = ${retryAt.toISOString()}::timestamptz,
          last_error_code = 'ledger_delivery_failed' where deletion_case_id = ${candidate.deletion_case_id} and status = 'pending'`
      }
    }
    return delivered
  }

  async #cleanupDeletedWorkspaces(cutoff: Date): Promise<number> {
    const candidates = await this.database.db.select({ id: workspaces.id, accountId: workspaces.accountId }).from(workspaces).where(and(
      sql`(
        ${workspaces.deletedAt} < ${cutoff.toISOString()}::timestamptz
        or exists (
          select 1 from account_deletion_cases due_case
          where due_case.account_id = ${workspaces.accountId}
            and due_case.status = 'scheduled'
            and due_case.purge_after is not null and due_case.purge_after <= now()
        )
      )`,
      // A deletion case intentionally keeps its tombstoned workspace until
      // the case reaches scheduled (which is only after purge_after). This
      // prevents generic tombstone maintenance from bypassing its configured
      // retention period or an active legal hold.
      sql`not exists (
        select 1 from account_deletion_cases c
        where c.account_id = ${workspaces.accountId}
          and (c.status in ('requested', 'cooling_off', 'held', 'purging')
            or (c.status = 'scheduled' and (c.purge_after is null or c.purge_after > now())))
      )`,
    )).orderBy(asc(workspaces.deletedAt)).limit(20)
    let removed = 0
    for (const workspace of candidates) {
      const connection = await this.database.sql.reserve()
      let deletionLockAcquired = false
      try {
        const [lock] = await connection<Array<{ acquired: boolean }>>`
          select pg_try_advisory_lock(hashtext(${workspaceLifecycleLockKey(workspace.id)})) as acquired`
        if (!lock?.acquired) continue
        const [deletionLock] = await connection<Array<{ acquired: boolean }>>`
          select pg_try_advisory_lock(hashtext(${`notegen-deletion:${workspace.accountId}`})) as acquired`
        if (!deletionLock?.acquired) continue
        deletionLockAcquired = true
        // Re-read under the shared lifecycle lock. A recovery which acquired
        // the same lock first makes this a no-op before any Blob side effect.
        // The subject lock additionally serializes active legal-hold changes
        // with this destructive Blob/workspace cleanup.
        const [current] = await connection<Array<{ id: string }>>`
          select w.id from workspaces w
          where w.id = ${workspace.id} and (
              w.deleted_at < ${cutoff.toISOString()}::timestamptz
              or exists (
                select 1 from account_deletion_cases due_case
                where due_case.account_id = w.account_id
                  and due_case.status = 'scheduled'
                  and due_case.purge_after is not null and due_case.purge_after <= now()
              )
            )
            and not exists (
              select 1 from legal_holds hold
              where hold.account_id = w.account_id and hold.released_at is null
            )
            and not exists (
              select 1 from account_deletion_cases c
              where c.account_id = w.account_id
                and (c.status in ('requested', 'cooling_off', 'held', 'purging')
                  or (c.status = 'scheduled' and (c.purge_after is null or c.purge_after > now())))
            )
          for update`
        if (current === undefined) continue
        const uploads = await connection<Array<{ storage_key: string, provider_upload_id: string }>>`
          select storage_key, provider_upload_id from blob_uploads
          where workspace_id = ${workspace.id} and completed_at is null`
        const storedBlobs = await connection<Array<{ storage_key: string }>>`
          select storage_key from blobs where workspace_id = ${workspace.id}`
        for (const upload of uploads) {
          await this.storage.abortUpload(upload.storage_key, upload.provider_upload_id).catch(() => undefined)
        }
        let storageClean = true
        for (const blob of storedBlobs) {
          try {
            await this.storage.delete(blob.storage_key)
          } catch {
            storageClean = false
            break
          }
        }
        if (!storageClean) continue
        const deleted = await connection<Array<{ id: string }>>`
          delete from workspaces where id = ${workspace.id} and (
              deleted_at < ${cutoff.toISOString()}::timestamptz
              or exists (
                select 1 from account_deletion_cases due_case
                where due_case.account_id = workspaces.account_id
                  and due_case.status = 'scheduled'
                  and due_case.purge_after is not null and due_case.purge_after <= now()
              )
            )
          returning id`
        removed += deleted.length
      } finally {
        if (deletionLockAcquired) {
          await connection`select pg_advisory_unlock(hashtext(${`notegen-deletion:${workspace.accountId}`}))`.catch(() => undefined)
        }
        await connection`select pg_advisory_unlock(hashtext(${workspaceLifecycleLockKey(workspace.id)}))`.catch(() => undefined)
        connection.release()
      }
    }
    return removed
  }
}

function emptyMaintenanceResult(): MaintenanceResult {
  return {
    skipped: true,
    bootstrapSessions: 0,
    syncBootstrapSessions: 0,
    deviceAuthorizations: 0,
    devicePairings: 0,
    webSessions: 0,
    stepUpGrants: 0,
    expiredMailPayloads: 0,
    completedUploads: 0,
    accounts: 0,
    expiredUploads: 0,
    workspaces: 0,
    changes: 0,
    versions: 0,
    operations: 0,
    syncEvents: 0,
    syncCommands: 0,
    syncCheckpoints: 0,
    syncConflicts: 0,
    syncDeviceCursors: 0,
    tombstones: 0,
    blobs: 0,
    deletionCases: 0,
    deletionLedgerDeliveries: 0,
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

function workspaceLifecycleLockKey(workspaceId: string): string {
  return `notegen-workspace-lifecycle:${workspaceId}`
}
