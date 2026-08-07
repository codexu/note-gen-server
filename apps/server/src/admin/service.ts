import { spawn } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import type { AppConfig } from '../config.js'
import type { BlobStorage } from '../storage/blob-storage.js'
import {
  accounts, adminAuditLogs, adminBackups, adminJobs, devices, refreshTokens, webSessions, workspaces,
} from '../database/schema.js'
import { ApiError } from '../errors.js'

export class AdminService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly storage?: BlobStorage,
    private readonly config?: AppConfig,
  ) {}

  async recoverInterruptedJobs(): Promise<void> {
    const now = new Date()
    await this.database.db.transaction(async (tx) => {
      await tx.update(adminJobs).set({
        status: 'failed', error: 'Server restarted before the job completed', finishedAt: now,
      }).where(inArray(adminJobs.status, ['pending', 'running']))
      await tx.update(adminBackups).set({ status: 'failed' }).where(eq(adminBackups.status, 'creating'))
    })
  }

  async listWebSessions(accountId: string, options: { limit: number, offset: number, query: string }) {
    await this.assertAdmin(accountId)
    const query = options.query.trim()
    const rows = await this.database.sql<Array<{
      id: string, account_id: string, account_login: string, expires_at: Date, last_seen_at: Date,
      last_ip: string | null, user_agent: string | null, created_at: Date
    }>>`
      select s.id, s.account_id, a.login as account_login, s.expires_at, s.last_seen_at,
        s.last_ip, s.user_agent, s.created_at
      from web_sessions s join accounts a on a.id = s.account_id
      where (${query} = '' or a.login ilike ('%' || ${query} || '%') or s.id::text ilike ('%' || ${query} || '%'))
      order by s.last_seen_at desc, s.id asc
      limit ${options.limit} offset ${options.offset}`
    const [total] = await this.database.sql<Array<{ count: number }>>`
      select count(*)::int as count from web_sessions s join accounts a on a.id = s.account_id
      where (${query} = '' or a.login ilike ('%' || ${query} || '%') or s.id::text ilike ('%' || ${query} || '%'))`
    return { total: total?.count ?? 0, sessions: rows.map((row) => ({
      id: row.id, accountId: row.account_id, accountLogin: row.account_login,
      expiresAt: row.expires_at, lastSeenAt: row.last_seen_at, lastIp: row.last_ip,
      userAgent: row.user_agent, createdAt: row.created_at,
    })) }
  }

  async revokeWebSession(actorAccountId: string, sessionId: string): Promise<void> {
    await this.assertAdmin(actorAccountId)
    await this.database.db.transaction(async (tx) => {
      const removed = await tx.delete(webSessions).where(eq(webSessions.id, sessionId)).returning({ id: webSessions.id })
      if (removed.length === 0) throw new ApiError({ code: 'web_session_not_found', message: 'Web session was not found', statusCode: 404 })
      await tx.insert(adminAuditLogs).values({
        actorAccountId, action: 'web-session.revoke', targetType: 'web-session', targetId: sessionId,
      })
    })
  }

  async revokeAccountWebSessions(actorAccountId: string, targetAccountId: string): Promise<{ revoked: number }> {
    await this.assertAdmin(actorAccountId)
    return this.database.db.transaction(async (tx) => {
      const removed = await tx.delete(webSessions).where(eq(webSessions.accountId, targetAccountId))
        .returning({ id: webSessions.id })
      await tx.insert(adminAuditLogs).values({
        actorAccountId, action: 'web-session.revoke-all', targetType: 'account', targetId: targetAccountId,
        metadata: { revoked: removed.length },
      })
      return { revoked: removed.length }
    })
  }

  async restoreWorkspace(actorAccountId: string, workspaceId: string): Promise<void> {
    await this.assertAdmin(actorAccountId)
    await this.database.db.transaction(async (tx) => {
      const restored = await tx.update(workspaces).set({ deletedAt: null, updatedAt: new Date() }).where(and(
        eq(workspaces.id, workspaceId), sql`${workspaces.deletedAt} is not null`,
      )).returning({ id: workspaces.id })
      if (restored.length === 0) throw new ApiError({ code: 'workspace_not_deleted', message: 'Deleted workspace was not found', statusCode: 404 })
      await tx.insert(adminAuditLogs).values({
        actorAccountId, action: 'workspace.admin-restore', targetType: 'workspace', targetId: workspaceId,
      })
    })
  }

  async getRuntimeConfiguration(accountId: string) {
    await this.assertAdmin(accountId)
    if (this.config === undefined) throw new ApiError({ code: 'configuration_unavailable', message: 'Runtime configuration is unavailable', statusCode: 503 })
    return {
      nodeEnv: this.config.nodeEnv,
      host: this.config.host,
      port: this.config.port,
      publicBaseUrl: this.config.publicBaseUrl,
      webPublicBaseUrl: this.config.webPublicBaseUrl,
      registrationMode: this.config.registrationMode,
      deploymentMode: this.config.deploymentMode,
      blobStorageDriver: this.config.blobStorageDriver,
      databasePoolSize: this.config.databasePoolSize,
      metricsEnabled: this.config.metricsEnabled,
      webEnabled: this.config.webEnabled,
      limits: {
        maxObjectBytes: this.config.maxObjectBytes,
        maxRequestBytes: this.config.maxRequestBytes,
        maxBlobBytes: this.config.maxBlobBytes,
        blobPartBytes: this.config.blobPartBytes,
      },
      retention: {
        changes: this.config.changeRetentionDays,
        versions: this.config.versionRetentionDays,
        tombstones: this.config.tombstoneRetentionDays,
      },
    }
  }

  async inspectStorage(accountId: string) {
    await this.assertAdmin(accountId)
    if (this.storage === undefined) throw new ApiError({ code: 'storage_unavailable', message: 'Blob storage is unavailable', statusCode: 503 })
    const rows = await this.database.sql<Array<{ storage_key: string }>>`select storage_key from blobs where state = 'ready'`
    const missing: string[] = []
    for (const row of rows) if (!await this.storage.exists(row.storage_key)) missing.push(row.storage_key)
    const databaseKeys = new Set(rows.map((row) => row.storage_key))
    const orphaned: string[] = []
    for await (const key of this.storage.listKeys()) if (!databaseKeys.has(key)) orphaned.push(key)
    return { checked: rows.length, missing, orphaned }
  }

  async reconcileStorage(actorAccountId: string, deleteOrphaned: boolean) {
    const report = await this.inspectStorage(actorAccountId)
    if (deleteOrphaned && this.storage !== undefined) {
      for (const key of report.orphaned) await this.storage.delete(key)
    }
    await this.recordAudit(actorAccountId, 'storage.reconcile', 'storage', null, {
      missing: report.missing.length, orphaned: report.orphaned.length, deleted: deleteOrphaned ? report.orphaned.length : 0,
    }).catch(() => undefined)
    return { ...report, deleted: deleteOrphaned ? report.orphaned.length : 0 }
  }

  async createBackup(actorAccountId: string): Promise<{ jobId: string, backupId: string }> {
    await this.assertAdmin(actorAccountId)
    if (this.config === undefined) throw new ApiError({ code: 'configuration_unavailable', message: 'Backup configuration is unavailable', statusCode: 503 })
    const created = await this.database.db.transaction(async (tx) => {
      const [job] = await tx.insert(adminJobs).values({ actorAccountId, type: 'backup.create' })
        .returning({ id: adminJobs.id })
      if (job === undefined) throw new Error('Backup job insert returned no row')
      const filename = `notegen-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${job.id}.dump`
      const [backup] = await tx.insert(adminBackups).values({ jobId: job.id, filename })
        .returning({ id: adminBackups.id })
      if (backup === undefined) throw new Error('Backup record insert returned no row')
      await tx.insert(adminAuditLogs).values({
        actorAccountId, action: 'backup.create', targetType: 'backup', targetId: backup.id,
      })
      return { jobId: job.id, backupId: backup.id, filename }
    })
    void this.#runBackup(created.jobId, created.backupId, created.filename)
    return { jobId: created.jobId, backupId: created.backupId }
  }

  async listBackups(accountId: string) {
    await this.assertAdmin(accountId)
    const rows = await this.database.db.select({
      id: adminBackups.id, jobId: adminBackups.jobId, filename: adminBackups.filename,
      size: adminBackups.size, status: adminBackups.status, createdAt: adminBackups.createdAt,
      completedAt: adminBackups.completedAt,
    }).from(adminBackups).orderBy(desc(adminBackups.createdAt)).limit(200)
    return rows.map((row) => ({ ...row, size: row.size?.toString() ?? null }))
  }

  async getBackupFile(accountId: string, backupId: string): Promise<{ path: string, filename: string }> {
    await this.assertAdmin(accountId)
    if (this.config === undefined) throw new ApiError({ code: 'configuration_unavailable', message: 'Backup configuration is unavailable', statusCode: 503 })
    const [backup] = await this.database.db.select({
      filename: adminBackups.filename, status: adminBackups.status,
    }).from(adminBackups).where(eq(adminBackups.id, backupId)).limit(1)
    if (backup === undefined || backup.status !== 'ready') {
      throw new ApiError({ code: 'backup_not_ready', message: 'Backup is missing or not ready', statusCode: 404 })
    }
    return { path: resolve(this.config.backupPath, backup.filename), filename: backup.filename }
  }

  async deleteBackup(actorAccountId: string, backupId: string): Promise<void> {
    const backup = await this.getBackupFile(actorAccountId, backupId)
    await this.database.db.transaction(async (tx) => {
      const changed = await tx.update(adminBackups).set({ status: 'deleting' }).where(eq(adminBackups.id, backupId))
        .returning({ id: adminBackups.id })
      if (changed.length === 0) throw new ApiError({ code: 'backup_not_found', message: 'Backup was not found', statusCode: 404 })
      await tx.insert(adminAuditLogs).values({
        actorAccountId, action: 'backup.delete', targetType: 'backup', targetId: backupId,
      })
    })
    await rm(backup.path, { force: true })
    await this.database.db.delete(adminBackups).where(eq(adminBackups.id, backupId))
  }

  async listJobs(accountId: string) {
    await this.assertAdmin(accountId)
    return this.database.db.select().from(adminJobs).orderBy(desc(adminJobs.createdAt)).limit(200)
  }

  async getJob(accountId: string, jobId: string) {
    await this.assertAdmin(accountId)
    const [job] = await this.database.db.select().from(adminJobs).where(eq(adminJobs.id, jobId)).limit(1)
    if (job === undefined) throw new ApiError({ code: 'job_not_found', message: 'Administrative job was not found', statusCode: 404 })
    return job
  }

  async #runBackup(jobId: string, backupId: string, filename: string): Promise<void> {
    if (this.config === undefined) return
    const startedAt = new Date()
    await this.database.db.update(adminJobs).set({ status: 'running', progress: 10, startedAt })
      .where(eq(adminJobs.id, jobId))
    try {
      await mkdir(this.config.backupPath, { recursive: true })
      const target = resolve(this.config.backupPath, filename)
      await runPgDump(this.config.databaseUrl, target)
      const details = await stat(target)
      const finishedAt = new Date()
      await this.database.db.transaction(async (tx) => {
        await tx.update(adminBackups).set({
          status: 'ready', size: BigInt(details.size), completedAt: finishedAt,
        }).where(eq(adminBackups.id, backupId))
        await tx.update(adminJobs).set({
          status: 'completed', progress: 100, finishedAt,
          result: { backupId, filename, size: details.size },
        }).where(eq(adminJobs.id, jobId))
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backup failed'
      await this.database.db.transaction(async (tx) => {
        await tx.update(adminBackups).set({ status: 'failed' }).where(eq(adminBackups.id, backupId))
        await tx.update(adminJobs).set({ status: 'failed', error: message, finishedAt: new Date() })
          .where(eq(adminJobs.id, jobId))
      })
    }
  }

  async assertAdmin(accountId: string): Promise<void> {
    const [account] = await this.database.db.select({ id: accounts.id }).from(accounts).where(and(
      eq(accounts.id, accountId),
      eq(accounts.isAdmin, true),
      isNull(accounts.suspendedAt),
      isNull(accounts.disabledAt),
    )).limit(1)
    if (account === undefined) {
      throw new ApiError({ code: 'admin_required', message: 'Administrator access is required', statusCode: 403 })
    }
  }

  async getOverview(accountId: string) {
    await this.assertAdmin(accountId)
    const [row] = await this.database.sql<Array<{
      account_count: number
      active_account_count: number
      workspace_count: number
      object_count: number
      deleted_object_count: number
      active_device_count: number
      audit_count: number
    }>>`
      select
        (select count(*)::int from accounts) as account_count,
        (select count(*)::int from accounts where disabled_at is null and suspended_at is null) as active_account_count,
        (select count(*)::int from workspaces where deleted_at is null) as workspace_count,
        (select count(*)::int from objects o join workspaces w on w.id = o.workspace_id
          where w.deleted_at is null and o.deleted_at is null) as object_count,
        (select count(*)::int from objects o join workspaces w on w.id = o.workspace_id
          where w.deleted_at is null and o.deleted_at is not null) as deleted_object_count,
        (select count(*)::int from devices where revoked_at is null) as active_device_count,
        (select count(*)::int from admin_audit_logs) as audit_count
    `
    return {
      accountCount: row?.account_count ?? 0,
      activeAccountCount: row?.active_account_count ?? 0,
      workspaceCount: row?.workspace_count ?? 0,
      objectCount: row?.object_count ?? 0,
      deletedObjectCount: row?.deleted_object_count ?? 0,
      activeDeviceCount: row?.active_device_count ?? 0,
      auditCount: row?.audit_count ?? 0,
    }
  }

  async listAccounts(accountId: string, options: {
    limit: number
    offset: number
    cursor?: string
    query: string
    status: 'all' | 'active' | 'suspended' | 'deletion'
  }) {
    await this.assertAdmin(accountId)
    const query = options.query.trim()
    const cursor = decodeCursor(options.cursor)
    const rows = await this.database.sql<Array<{
      id: string
      login: string
      is_admin: boolean
      suspended_at: Date | null
      disabled_at: Date | null
      created_at: Date
      workspace_count: number
      object_count: number
      device_count: number
    }>>`
      select a.id, a.login, a.is_admin, a.suspended_at, a.disabled_at, a.created_at,
        (select count(*)::int from workspaces w where w.account_id = a.id and w.deleted_at is null) as workspace_count,
        (select count(*)::int from objects o join workspaces w on w.id = o.workspace_id
          where w.account_id = a.id and w.deleted_at is null and o.deleted_at is null) as object_count,
        (select count(*)::int from devices d where d.account_id = a.id and d.revoked_at is null) as device_count
      from accounts a
      where (${query} = '' or a.login ilike ('%' || ${query} || '%'))
        and (${options.status} = 'all'
          or (${options.status} = 'active' and a.suspended_at is null and a.disabled_at is null)
          or (${options.status} = 'suspended' and a.suspended_at is not null)
          or (${options.status} = 'deletion' and a.disabled_at is not null))
        and (${cursor?.at ?? null}::timestamptz is null
          or a.created_at < ${cursor?.at ?? null}::timestamptz
          or (a.created_at = ${cursor?.at ?? null}::timestamptz and a.id::text < ${cursor?.id ?? ''}))
      order by a.created_at desc, a.id desc
      limit ${options.limit} offset ${options.offset}
    `
    const [total] = await this.database.sql<Array<{ count: number }>>`
      select count(*)::int as count from accounts a
      where (${query} = '' or a.login ilike ('%' || ${query} || '%'))
        and (${options.status} = 'all'
          or (${options.status} = 'active' and a.suspended_at is null and a.disabled_at is null)
          or (${options.status} = 'suspended' and a.suspended_at is not null)
          or (${options.status} = 'deletion' and a.disabled_at is not null))
    `
    return {
      total: total?.count ?? 0,
      accounts: rows.map((row) => ({
        id: row.id,
        login: row.login,
        isAdmin: row.is_admin,
        suspendedAt: row.suspended_at,
        deletionRequestedAt: row.disabled_at,
        createdAt: row.created_at,
        workspaceCount: row.workspace_count,
        objectCount: row.object_count,
        deviceCount: row.device_count,
      })),
      nextCursor: rows.length === options.limit
        ? encodeCursor(rows.at(-1)!.created_at, rows.at(-1)!.id)
        : null,
    }
  }

  async listWorkspaces(accountId: string, options: { limit: number, offset: number, query: string, cursor?: string }) {
    await this.assertAdmin(accountId)
    const query = options.query.trim()
    const cursor = decodeCursor(options.cursor)
    const rows = await this.database.sql<Array<{
      id: string
      account_id: string
      account_login: string
      is_default: boolean
      deleted_at: Date | null
      created_at: Date
      updated_at: Date
      object_count: number
      deleted_object_count: number
      object_bytes: string
      encryption_mode: 'managed' | 'e2ee'
    }>>`
      select w.id, w.account_id, a.login as account_login, w.is_default, w.deleted_at,
        w.created_at, w.updated_at,
        (select count(*)::int from objects o where o.workspace_id = w.id and o.deleted_at is null) as object_count,
        (select count(*)::int from objects o where o.workspace_id = w.id and o.deleted_at is not null) as deleted_object_count,
        (select coalesce(sum(octet_length(o.ciphertext)), 0)::text from objects o where o.workspace_id = w.id) as object_bytes,
        case when exists(select 1 from workspace_key_envelopes e
          where e.workspace_id = w.id and e.envelope_type = 'managed') then 'managed' else 'e2ee' end as encryption_mode
      from workspaces w join accounts a on a.id = w.account_id
      where (${query} = '' or a.login ilike ('%' || ${query} || '%') or w.id::text ilike ('%' || ${query} || '%'))
        and (${cursor?.at ?? null}::timestamptz is null
          or w.created_at < ${cursor?.at ?? null}::timestamptz
          or (w.created_at = ${cursor?.at ?? null}::timestamptz and w.id::text < ${cursor?.id ?? ''}))
      order by w.created_at desc, w.id desc
      limit ${options.limit} offset ${options.offset}
    `
    const [total] = await this.database.sql<Array<{ count: number }>>`
      select count(*)::int as count from workspaces w join accounts a on a.id = w.account_id
      where (${query} = '' or a.login ilike ('%' || ${query} || '%') or w.id::text ilike ('%' || ${query} || '%'))
    `
    return { total: total?.count ?? 0, workspaces: rows.map((row) => ({
      id: row.id, accountId: row.account_id, accountLogin: row.account_login,
      isDefault: row.is_default, deletedAt: row.deleted_at, createdAt: row.created_at,
      updatedAt: row.updated_at, objectCount: row.object_count,
      deletedObjectCount: row.deleted_object_count, objectBytes: row.object_bytes,
      encryptionMode: row.encryption_mode,
    })), nextCursor: rows.length === options.limit
      ? encodeCursor(rows.at(-1)!.created_at, rows.at(-1)!.id)
      : null }
  }

  async listDevices(accountId: string, options: { limit: number, offset: number, query: string, cursor?: string }) {
    await this.assertAdmin(accountId)
    const query = options.query.trim()
    const cursor = decodeCursor(options.cursor)
    const rows = await this.database.sql<Array<{
      id: string
      account_id: string
      account_login: string
      name: string
      platform: string
      revoked_at: Date | null
      last_seen_at: Date
      created_at: Date
    }>>`
      select d.id, d.account_id, a.login as account_login, d.name, d.platform,
        d.revoked_at, d.last_seen_at, d.created_at
      from devices d join accounts a on a.id = d.account_id
      where (${query} = '' or a.login ilike ('%' || ${query} || '%')
        or d.name ilike ('%' || ${query} || '%') or d.id::text ilike ('%' || ${query} || '%'))
        and (${cursor?.at ?? null}::timestamptz is null
          or d.created_at < ${cursor?.at ?? null}::timestamptz
          or (d.created_at = ${cursor?.at ?? null}::timestamptz and d.id::text < ${cursor?.id ?? ''}))
      order by d.created_at desc, d.id desc
      limit ${options.limit} offset ${options.offset}
    `
    const [total] = await this.database.sql<Array<{ count: number }>>`
      select count(*)::int as count from devices d join accounts a on a.id = d.account_id
      where (${query} = '' or a.login ilike ('%' || ${query} || '%')
        or d.name ilike ('%' || ${query} || '%') or d.id::text ilike ('%' || ${query} || '%'))
    `
    return { total: total?.count ?? 0, devices: rows.map((row) => ({
      id: row.id, accountId: row.account_id, accountLogin: row.account_login,
      name: row.name, platform: row.platform, revokedAt: row.revoked_at,
      lastSeenAt: row.last_seen_at, createdAt: row.created_at,
    })), nextCursor: rows.length === options.limit
      ? encodeCursor(rows.at(-1)!.created_at, rows.at(-1)!.id)
      : null }
  }

  async getSystemStatus(accountId: string) {
    await this.assertAdmin(accountId)
    const started = performance.now()
    await this.database.check()
    const [row] = await this.database.sql<Array<{
      database_bytes: string
      blob_count: number
      blob_bytes: string
      object_bytes: string
      version_count: number
      change_count: number
    }>>`
      select pg_database_size(current_database())::text as database_bytes,
        (select count(*)::int from blobs where state = 'ready') as blob_count,
        (select coalesce(sum(size), 0)::text from blobs where state = 'ready') as blob_bytes,
        (select coalesce(sum(octet_length(ciphertext)), 0)::text from objects) as object_bytes,
        (select count(*)::int from object_versions) as version_count,
        (select count(*)::int from changes) as change_count
    `
    const memory = process.memoryUsage()
    return {
      status: 'ok' as const,
      databaseLatencyMs: Math.round((performance.now() - started) * 10) / 10,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryRssBytes: memory.rss.toString(),
      heapUsedBytes: memory.heapUsed.toString(),
      databaseBytes: row?.database_bytes ?? '0',
      blobCount: row?.blob_count ?? 0,
      blobBytes: row?.blob_bytes ?? '0',
      objectBytes: row?.object_bytes ?? '0',
      versionCount: row?.version_count ?? 0,
      changeCount: row?.change_count ?? 0,
      checkedAt: new Date(),
    }
  }

  async deleteWorkspace(actorAccountId: string, workspaceId: string): Promise<void> {
    await this.assertAdmin(actorAccountId)
    await this.database.db.transaction(async (tx) => {
      const [target] = await tx.select({
        id: workspaces.id, isDefault: workspaces.isDefault, deletedAt: workspaces.deletedAt,
      }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1).for('update')
      if (target === undefined) throw new ApiError({ code: 'workspace_not_found', message: 'Workspace was not found', statusCode: 404 })
      if (target.isDefault) throw new ApiError({ code: 'workspace_default_delete_forbidden', message: 'Default workspace cannot be deleted', statusCode: 409 })
      if (target.deletedAt === null) {
        const now = new Date()
        await tx.update(workspaces).set({ deletedAt: now, updatedAt: now }).where(eq(workspaces.id, workspaceId))
      }
      await tx.insert(adminAuditLogs).values({
        actorAccountId, action: 'workspace.admin-delete', targetType: 'workspace', targetId: workspaceId,
      })
    })
  }

  async revokeDevice(actorAccountId: string, deviceId: string): Promise<void> {
    await this.assertAdmin(actorAccountId)
    await this.database.db.transaction(async (tx) => {
      const now = new Date()
      const changed = await tx.update(devices).set({ revokedAt: now, updatedAt: now })
        .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt))).returning({ id: devices.id })
      if (changed.length === 0) throw new ApiError({ code: 'device_not_found', message: 'Active device was not found', statusCode: 404 })
      await tx.update(refreshTokens).set({ revokedAt: now }).where(and(
        eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt),
      ))
      await tx.insert(adminAuditLogs).values({
        actorAccountId, action: 'device.admin-revoke', targetType: 'device', targetId: deviceId,
      })
    })
  }

  async batchSetAccountsSuspended(
    actorAccountId: string,
    accountIds: string[],
    suspended: boolean,
  ): Promise<{ updated: number }> {
    await this.assertAdmin(actorAccountId)
    const uniqueAccountIds = [...new Set(accountIds)]
    if (uniqueAccountIds.includes(actorAccountId)) {
      throw new ApiError({ code: 'admin_self_disable_forbidden', message: 'Administrators cannot disable themselves', statusCode: 409 })
    }
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-admin-role'))`)
      const targets = await tx.select({
        id: accounts.id, isAdmin: accounts.isAdmin, suspendedAt: accounts.suspendedAt, disabledAt: accounts.disabledAt,
      }).from(accounts).where(inArray(accounts.id, uniqueAccountIds)).for('update')
      if (targets.length !== uniqueAccountIds.length) {
        throw new ApiError({ code: 'account_not_found', message: 'One or more accounts were not found', statusCode: 404 })
      }
      if (targets.some((target) => target.disabledAt !== null)) {
        throw new ApiError({ code: 'account_pending_deletion', message: 'An account pending deletion cannot be suspended or resumed', statusCode: 409 })
      }
      if (suspended && targets.some((target) => target.isAdmin)) {
        const [otherAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
          eq(accounts.isAdmin, true), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
          notInArray(accounts.id, uniqueAccountIds),
        )).limit(1)
        if (otherAdmin === undefined) {
          throw new ApiError({ code: 'last_admin_disable_forbidden', message: 'The last active administrator cannot be disabled', statusCode: 409 })
        }
      }
      const now = new Date()
      await tx.update(accounts).set({ suspendedAt: suspended ? now : null, updatedAt: now })
        .where(inArray(accounts.id, uniqueAccountIds))
      if (suspended) {
        await tx.update(devices).set({ revokedAt: now, updatedAt: now }).where(and(
          inArray(devices.accountId, uniqueAccountIds), isNull(devices.revokedAt),
        ))
        await tx.update(refreshTokens).set({ revokedAt: now }).where(and(
          inArray(refreshTokens.accountId, uniqueAccountIds), isNull(refreshTokens.revokedAt),
        ))
        await tx.delete(webSessions).where(inArray(webSessions.accountId, uniqueAccountIds))
      }
      await tx.insert(adminAuditLogs).values(uniqueAccountIds.map((targetAccountId) => ({
        actorAccountId,
        action: suspended ? 'account.suspend' : 'account.resume',
        targetType: 'account',
        targetId: targetAccountId,
      })))
    })
    return { updated: uniqueAccountIds.length }
  }

  async setAccountSuspended(actorAccountId: string, targetAccountId: string, suspended: boolean): Promise<void> {
    await this.batchSetAccountsSuspended(actorAccountId, [targetAccountId], suspended)
  }

  async listAudit(accountId: string, options: {
    limit: number
    offset: number
    query: string
    action: string
    cursor?: string
  }) {
    await this.assertAdmin(accountId)
    const query = options.query.trim()
    const cursor = decodeCursor(options.cursor)
    const rows = await this.database.sql<Array<{
      id: string
      actor_account_id: string
      actor_login: string
      action: string
      target_type: string
      target_id: string | null
      metadata: Record<string, unknown>
      created_at: Date
    }>>`
      select l.id::text, l.actor_account_id, a.login as actor_login, l.action,
        l.target_type, l.target_id, l.metadata, l.created_at
      from admin_audit_logs l join accounts a on a.id = l.actor_account_id
      where (${query} = '' or a.login ilike ('%' || ${query} || '%')
        or coalesce(l.target_id, '') ilike ('%' || ${query} || '%'))
        and (${options.action} = '' or l.action = ${options.action})
        and (${cursor?.at ?? null}::timestamptz is null
          or l.created_at < ${cursor?.at ?? null}::timestamptz
          or (l.created_at = ${cursor?.at ?? null}::timestamptz and l.id < ${cursor?.id ?? '0'}::bigint))
      order by l.created_at desc, l.id desc
      limit ${options.limit} offset ${options.offset}
    `
    const [total] = await this.database.sql<Array<{ count: number }>>`
      select count(*)::int as count
      from admin_audit_logs l join accounts a on a.id = l.actor_account_id
      where (${query} = '' or a.login ilike ('%' || ${query} || '%')
        or coalesce(l.target_id, '') ilike ('%' || ${query} || '%'))
        and (${options.action} = '' or l.action = ${options.action})
    `
    return { total: total?.count ?? 0, entries: rows.map((row) => ({
      id: row.id, actorAccountId: row.actor_account_id, actorLogin: row.actor_login,
      action: row.action, targetType: row.target_type, targetId: row.target_id,
      metadata: row.metadata, createdAt: row.created_at,
    })), nextCursor: rows.length === options.limit
      ? encodeCursor(rows.at(-1)!.created_at, rows.at(-1)!.id)
      : null }
  }

  async deleteOldAudit(accountId: string, retentionDays: number): Promise<{ deleted: number }> {
    await this.assertAdmin(accountId)
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
    return this.database.db.transaction(async (tx) => {
      const removed = await tx.delete(adminAuditLogs)
        .where(sql`${adminAuditLogs.createdAt} < ${cutoff}`).returning({ id: adminAuditLogs.id })
      await tx.insert(adminAuditLogs).values({
        actorAccountId: accountId,
        action: 'audit.cleanup',
        targetType: 'audit',
        targetId: null,
        metadata: { retentionDays, deleted: removed.length },
      })
      return { deleted: removed.length }
    })
  }

  async setAccountAdmin(actorAccountId: string, targetAccountId: string, isAdmin: boolean): Promise<void> {
    await this.assertAdmin(actorAccountId)
    if (actorAccountId === targetAccountId && !isAdmin) {
      throw new ApiError({
        code: 'admin_self_demote_forbidden',
        message: 'Administrators cannot remove their own administrator role',
        statusCode: 409,
      })
    }
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-admin-role'))`)
      const [target] = await tx.select({
        id: accounts.id,
        isAdmin: accounts.isAdmin,
        disabledAt: accounts.disabledAt,
      }).from(accounts).where(eq(accounts.id, targetAccountId)).limit(1).for('update')
      if (target === undefined) {
        throw new ApiError({ code: 'account_not_found', message: 'Account was not found', statusCode: 404 })
      }
      if (target.disabledAt !== null) {
        throw new ApiError({
          code: 'account_pending_deletion',
          message: 'An account pending deletion cannot change administrator role',
          statusCode: 409,
        })
      }
      if (!isAdmin && target.isAdmin) {
        const [otherAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
          eq(accounts.isAdmin, true),
          ne(accounts.id, targetAccountId),
          isNull(accounts.suspendedAt),
          isNull(accounts.disabledAt),
        )).limit(1)
        if (otherAdmin === undefined) {
          throw new ApiError({
            code: 'last_admin_demote_forbidden',
            message: 'The last active administrator cannot be demoted',
            statusCode: 409,
          })
        }
      }
      await tx.update(accounts).set({ isAdmin, updatedAt: new Date() }).where(eq(accounts.id, targetAccountId))
      await tx.insert(adminAuditLogs).values({
        actorAccountId,
        action: isAdmin ? 'account.admin-grant' : 'account.admin-revoke',
        targetType: 'account',
        targetId: targetAccountId,
      })
    })
  }

  async recordAudit(
    actorAccountId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.database.db.insert(adminAuditLogs).values({
      actorAccountId,
      action,
      targetType,
      targetId,
      metadata,
    })
  }
}

async function runPgDump(databaseUrl: string, target: string): Promise<void> {
  const url = new URL(databaseUrl)
  const args = [
    '--format=custom', '--no-owner', '--no-privileges', '--file', target,
    '--host', url.hostname, '--port', url.port || '5432', '--username', decodeURIComponent(url.username),
    url.pathname.replace(/^\//, ''),
  ]
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('pg_dump', args, {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk.slice(0, 4_000) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(stderr.trim() || `pg_dump exited with status ${String(code)}`)))
  })
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url')
}

function decodeCursor(value: string | undefined): { at: string, id: string } | null {
  if (value === undefined || value.length === 0) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || !('at' in parsed) || !('id' in parsed)
      || typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at)) || typeof parsed.id !== 'string') {
      throw new Error('invalid cursor')
    }
    return { at: parsed.at, id: parsed.id }
  } catch {
    throw new ApiError({ code: 'pagination_cursor_invalid', message: 'Pagination cursor is invalid', statusCode: 400 })
  }
}
