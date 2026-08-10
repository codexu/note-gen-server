import { and, asc, eq, isNull, lt, or } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import {
  blobs, blobUploads, bootstrapSessions, deviceAuthorizations, devicePairings,
  syncV2BootstrapSessions, webSessions, workspaces,
} from '../database/schema.js'
import type { BlobStorage } from '../storage/blob-storage.js'
import { BLOB_COMPLETION_LEASE_MS } from '../blobs/constants.js'

export interface MaintenanceResult {
  skipped: boolean
  bootstrapSessions: number
  syncV2BootstrapSessions: number
  deviceAuthorizations: number
  devicePairings: number
  webSessions: number
  completedUploads: number
  accounts: number
  expiredUploads: number
  workspaces: number
  changes: number
  versions: number
  operations: number
  tombstones: number
  blobs: number
}

export class MaintenanceService {
  #timer: NodeJS.Timeout | undefined
  #running = false

  constructor(
    private readonly database: DatabaseContext,
    private readonly storage: BlobStorage,
    private readonly config: AppConfig,
  ) {}

  start(
    intervalMs = 60 * 60 * 1000,
    onError: (error: unknown) => void = (error) => console.error('Maintenance failed', error),
  ): () => void {
    if (this.#timer !== undefined) return () => this.stop()
    this.#timer = setInterval(() => void this.runOnce().catch(onError), intervalMs)
    this.#timer.unref()
    return () => this.stop()
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async runOnce(): Promise<MaintenanceResult> {
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
    const removedSyncV2BootstrapSessions = await this.database.db.delete(syncV2BootstrapSessions)
      .where(lt(syncV2BootstrapSessions.expiresAt, new Date()))
      .returning({ id: syncV2BootstrapSessions.id })
    const removedDeviceAuthorizations = await this.database.db.delete(deviceAuthorizations)
      .where(lt(deviceAuthorizations.expiresAt, new Date()))
      .returning({ id: deviceAuthorizations.id })
    const removedDevicePairings = await this.database.db.delete(devicePairings)
      .where(lt(devicePairings.expiresAt, new Date()))
      .returning({ id: devicePairings.id })
    const removedWebSessions = await this.database.db.delete(webSessions)
      .where(lt(webSessions.expiresAt, new Date()))
      .returning({ id: webSessions.id })
    await this.database.sql`delete from rate_limit_buckets where expires_at < now()`
    const removedCompletedUploads = await this.database.db.delete(blobUploads).where(and(
      lt(blobUploads.completedAt, daysAgo(7)),
    )).returning({ id: blobUploads.id })
    const expiredUploads = await this.#cleanupUploads()
    const changeCutoff = daysAgo(this.config.changeRetentionDays)
    const versionCutoff = daysAgo(this.config.versionRetentionDays)
    const tombstoneCutoff = daysAgo(this.config.tombstoneRetentionDays)
    const removedWorkspaces = await this.#cleanupDeletedWorkspaces(tombstoneCutoff)
    const removedAccounts = await this.database.sql<Array<{ id: string }>>`
      delete from accounts a
      where a.disabled_at is not null
        and a.disabled_at < ${tombstoneCutoff.toISOString()}::timestamptz
        and not exists (select 1 from workspaces w where w.account_id = a.id)
      returning a.id`
    const [changesResult, versionsResult, operationsResult, tombstonesResult, blobsResult] =
      await this.database.sql.begin(async (sql) => {
        const removedChanges = await sql`
          delete from changes where id in (
            select id from changes where created_at < ${changeCutoff.toISOString()}::timestamptz order by id limit 10000
          ) returning id`
        const removedVersions = await sql`
          delete from object_versions v where (v.workspace_id, v.object_id, v.revision) in (
            select v2.workspace_id, v2.object_id, v2.revision
            from object_versions v2
            left join objects o on o.workspace_id = v2.workspace_id and o.object_id = v2.object_id
            where v2.created_at < ${versionCutoff.toISOString()}::timestamptz
              and (o.object_id is null or v2.revision <> o.current_revision)
              and not exists (
                select 1 from changes c
                where c.workspace_id = v2.workspace_id
                  and c.object_id = v2.object_id
                  and c.revision = v2.revision
              )
              and not exists (
                select 1 from bootstrap_sessions s
                where s.workspace_id = v2.workspace_id
                  and s.expires_at > now()
                  and v2.sequence <= s.snapshot_sequence
              )
              and not exists (
                select 1 from sync_v2_bootstrap_objects bo
                join sync_v2_bootstrap_sessions bs on bs.id = bo.session_id
                where bo.workspace_id = v2.workspace_id
                  and bo.object_id = v2.object_id
                  and bo.revision = v2.revision
                  and bs.expires_at > now()
              )
              and not exists (
                select 1 from sync_v2_resource_bindings rb
                where rb.workspace_id = v2.workspace_id
                  and rb.resource_object_id = v2.object_id
                  and rb.resource_revision = v2.revision
              )
            limit 5000
          ) returning revision`
        const removedOperations = await sql`
          delete from operations where (workspace_id, operation_id) in (
            select workspace_id, operation_id from operations
            where created_at < ${changeCutoff.toISOString()}::timestamptz limit 10000
          ) returning operation_id`
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
        return [removedChanges, removedVersions, removedOperations, removedTombstones, candidates] as const
      })

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
      syncV2BootstrapSessions: removedSyncV2BootstrapSessions.length,
      deviceAuthorizations: removedDeviceAuthorizations.length,
      devicePairings: removedDevicePairings.length,
      webSessions: removedWebSessions.length,
      completedUploads: removedCompletedUploads.length,
      accounts: removedAccounts.length,
      expiredUploads,
      workspaces: removedWorkspaces,
      changes: changesResult.length,
      versions: versionsResult.length,
      operations: operationsResult.length,
      tombstones: tombstonesResult.length,
      blobs: removedBlobs,
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
      await this.database.db.delete(blobUploads).where(eq(blobUploads.id, upload.id))
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

  async #cleanupDeletedWorkspaces(cutoff: Date): Promise<number> {
    const candidates = await this.database.db.select({ id: workspaces.id }).from(workspaces).where(and(
      lt(workspaces.deletedAt, cutoff),
    )).orderBy(asc(workspaces.deletedAt)).limit(20)
    let removed = 0
    for (const workspace of candidates) {
      const uploads = await this.database.db.select({
        storageKey: blobUploads.storageKey,
        providerUploadId: blobUploads.providerUploadId,
      }).from(blobUploads).where(and(
        eq(blobUploads.workspaceId, workspace.id), isNull(blobUploads.completedAt),
      ))
      const storedBlobs = await this.database.db.select({ storageKey: blobs.storageKey }).from(blobs)
        .where(eq(blobs.workspaceId, workspace.id))
      let storageClean = true
      for (const upload of uploads) {
        await this.storage.abortUpload(upload.storageKey, upload.providerUploadId).catch(() => undefined)
      }
      for (const blob of storedBlobs) {
        try {
          await this.storage.delete(blob.storageKey)
        } catch {
          storageClean = false
          break
        }
      }
      if (!storageClean) continue
      const deleted = await this.database.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
        .returning({ id: workspaces.id })
      removed += deleted.length
    }
    return removed
  }
}

function emptyMaintenanceResult(): MaintenanceResult {
  return {
    skipped: true,
    bootstrapSessions: 0,
    syncV2BootstrapSessions: 0,
    deviceAuthorizations: 0,
    devicePairings: 0,
    webSessions: 0,
    completedUploads: 0,
    accounts: 0,
    expiredUploads: 0,
    workspaces: 0,
    changes: 0,
    versions: 0,
    operations: 0,
    tombstones: 0,
    blobs: 0,
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}
