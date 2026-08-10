import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { devices, objects, workspaceKeyEnvelopes, workspaceKeys, workspaces } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { ChangeNotifier } from '../sync/types.js'

export interface CreateWorkspaceInput {
  nameCiphertext: string
  keyVersion: number
  envelopes: KeyEnvelopeInput[]
}

export interface KeyEnvelopeInput {
  type: 'passphrase' | 'recovery' | 'device' | 'managed'
  recipientId: string | null
  wrappedKey: string
  kdfSalt: string | null
  kdfParams: Record<string, number> | null
}

type SyncObjectKind = typeof objects.$inferSelect.kind

export class WorkspaceService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly notifier: ChangeNotifier,
  ) {}

  async create(accountId: string, input: CreateWorkspaceInput) {
    validateKeyEnvelopes(input.envelopes, true)
    await this.#validateDeviceRecipients(accountId, input.envelopes)
    const created = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${accountId}))`)
      const [currentDefault] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(
        eq(workspaces.accountId, accountId),
        eq(workspaces.isDefault, true),
        isNull(workspaces.deletedAt),
      )).limit(1)
      const [workspace] = await tx.insert(workspaces).values({
        accountId,
        nameCiphertext: input.nameCiphertext,
        isDefault: currentDefault === undefined,
      }).returning({ id: workspaces.id, createdAt: workspaces.createdAt })
      if (workspace === undefined) throw new Error('Workspace insert returned no row')
      await tx.insert(workspaceKeys).values({ workspaceId: workspace.id, keyVersion: input.keyVersion })
      await tx.insert(workspaceKeyEnvelopes).values(input.envelopes.map((envelope) => ({
        workspaceId: workspace.id, keyVersion: input.keyVersion, ...envelope,
      })))
      return { ...workspace, latestSequence: '0', nameCiphertext: input.nameCiphertext }
    })
    await this.#publishWorkspaceListChanged(accountId)
    return created
  }

  async getOrCreateManagedDefault(accountId: string, input: {
    nameCiphertext: string
    managedKey: string
  }) {
    const envelope: KeyEnvelopeInput = {
      type: 'managed',
      recipientId: null,
      wrappedKey: input.managedKey,
      kdfSalt: null,
      kdfParams: null,
    }
    validateKeyEnvelopes([envelope], false, true)
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.managedKey)) {
      throw new ApiError({
        code: 'managed_key_invalid',
        message: 'Managed key must be a 256-bit Base64URL value',
        statusCode: 400,
      })
    }
    const result = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${accountId}))`)
      const [existing] = await tx.select({
        id: workspaces.id,
        createdAt: workspaces.createdAt,
        latestSequence: workspaces.latestSequence,
        nameCiphertext: workspaces.nameCiphertext,
      }).from(workspaces).where(and(
        eq(workspaces.accountId, accountId),
        eq(workspaces.isDefault, true),
        isNull(workspaces.deletedAt),
      )).limit(1)
      if (existing !== undefined) {
        // The current default is authoritative. E2EE workspaces must be returned for client-side
        // unlocking instead of being demoted and replaced during every managed startup attempt.
        const [managedEnvelope] = await tx.select({ id: workspaceKeyEnvelopes.id })
          .from(workspaceKeyEnvelopes)
          .where(and(
            eq(workspaceKeyEnvelopes.workspaceId, existing.id),
            eq(workspaceKeyEnvelopes.type, 'managed'),
          ))
          .limit(1)
        return {
          ...existing,
          latestSequence: existing.latestSequence.toString(),
          encryptionMode: managedEnvelope === undefined ? 'e2ee' as const : 'managed' as const,
          created: false,
        }
      }

      const [workspace] = await tx.insert(workspaces).values({
        accountId,
        nameCiphertext: input.nameCiphertext,
        isDefault: true,
      }).returning({
        id: workspaces.id,
        createdAt: workspaces.createdAt,
        latestSequence: workspaces.latestSequence,
        nameCiphertext: workspaces.nameCiphertext,
      })
      if (workspace === undefined) throw new Error('Managed workspace insert returned no row')
      await tx.insert(workspaceKeys).values({ workspaceId: workspace.id, keyVersion: 1 })
      await tx.insert(workspaceKeyEnvelopes).values({
        workspaceId: workspace.id,
        keyVersion: 1,
        ...envelope,
      })
      return {
        ...workspace,
        latestSequence: workspace.latestSequence.toString(),
        encryptionMode: 'managed' as const,
        created: true,
      }
    })
    if (result.created) await this.#publishWorkspaceListChanged(accountId)
    return result
  }

  async list(accountId: string, deviceId: string, includeDeleted: boolean) {
    const rows = await this.database.db.select({
      id: workspaces.id,
      nameCiphertext: workspaces.nameCiphertext,
      latestSequence: workspaces.latestSequence,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
      deletedAt: workspaces.deletedAt,
    }).from(workspaces).where(and(
      eq(workspaces.accountId, accountId),
      ...(includeDeleted ? [] : [isNull(workspaces.deletedAt)]),
    ))
      .orderBy(desc(workspaces.updatedAt))
    if (rows.length === 0) return []

    const workspaceIds = rows.map((row) => row.id)
    const [keyVersions, deviceEnvelopes, managedEnvelopes] = await Promise.all([
      this.database.db.select({
        workspaceId: workspaceKeys.workspaceId,
        latestKeyVersion: sql<number>`max(${workspaceKeys.keyVersion})::int`,
      }).from(workspaceKeys).where(inArray(workspaceKeys.workspaceId, workspaceIds))
        .groupBy(workspaceKeys.workspaceId),
      this.database.db.select({ workspaceId: workspaceKeyEnvelopes.workspaceId })
        .from(workspaceKeyEnvelopes).where(and(
          inArray(workspaceKeyEnvelopes.workspaceId, workspaceIds),
          eq(workspaceKeyEnvelopes.type, 'device'),
          eq(workspaceKeyEnvelopes.recipientId, deviceId),
        )),
      this.database.db.select({ workspaceId: workspaceKeyEnvelopes.workspaceId })
        .from(workspaceKeyEnvelopes).where(and(
          inArray(workspaceKeyEnvelopes.workspaceId, workspaceIds),
          eq(workspaceKeyEnvelopes.type, 'managed'),
        )),
    ])
    const latestKeyVersionByWorkspace = new Map(keyVersions.map((item) => (
      [item.workspaceId, item.latestKeyVersion] as const
    )))
    const deviceWorkspaceIds = new Set(deviceEnvelopes.map((item) => item.workspaceId))
    const managedWorkspaceIds = new Set(managedEnvelopes.map((item) => item.workspaceId))
    return rows.map((row) => ({
      ...row,
      latestSequence: row.latestSequence.toString(),
      latestKeyVersion: latestKeyVersionByWorkspace.get(row.id) ?? 0,
      hasDeviceEnvelope: deviceWorkspaceIds.has(row.id),
      encryptionMode: managedWorkspaceIds.has(row.id) ? 'managed' as const : 'e2ee' as const,
    }))
  }

  async getAccountSyncOverview(accountId: string) {
    const [summaries, kinds, recentActivity] = await Promise.all([
      this.database.sql<Array<{
        workspace_count: number
        object_count: number
        deleted_object_count: number
        object_bytes: string
        blob_count: number
        blob_bytes: string
        latest_sequence: string
        last_activity_at: Date | null
        encryption_mode: 'managed' | 'e2ee' | 'mixed' | null
      }>>`
        select
          (select count(*)::int from workspaces w
            where w.account_id = ${accountId} and w.deleted_at is null) as workspace_count,
          (select count(*)::int from objects o join workspaces w on w.id = o.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null and o.deleted_at is null) as object_count,
          (select count(*)::int from objects o join workspaces w on w.id = o.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null and o.deleted_at is not null) as deleted_object_count,
          (select coalesce(sum(octet_length(o.ciphertext)), 0)::text
            from objects o join workspaces w on w.id = o.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null) as object_bytes,
          (select count(*)::int from blobs b join workspaces w on w.id = b.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null and b.state = 'ready') as blob_count,
          (select coalesce(sum(b.size), 0)::text from blobs b join workspaces w on w.id = b.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null and b.state = 'ready') as blob_bytes,
          (select coalesce(max(w.latest_sequence), 0)::text from workspaces w
            where w.account_id = ${accountId} and w.deleted_at is null) as latest_sequence,
          (select max(c.created_at) from changes c join workspaces w on w.id = c.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null) as last_activity_at,
          (select case
              when count(*) = 0 then null
              when bool_and(exists(select 1 from workspace_key_envelopes e
                where e.workspace_id = w.id and e.envelope_type = 'managed')) then 'managed'
              when bool_and(not exists(select 1 from workspace_key_envelopes e
                where e.workspace_id = w.id and e.envelope_type = 'managed')) then 'e2ee'
              else 'mixed'
            end
            from workspaces w where w.account_id = ${accountId} and w.deleted_at is null) as encryption_mode
      `,
      this.database.sql<Array<{
        kind: string
        active_count: number
        deleted_count: number
        updated_at: Date
      }>>`
        select o.kind::text as kind,
          count(*) filter (where o.deleted_at is null)::int as active_count,
          count(*) filter (where o.deleted_at is not null)::int as deleted_count,
          max(o.updated_at) as updated_at
        from objects o join workspaces w on w.id = o.workspace_id
        where w.account_id = ${accountId} and w.deleted_at is null
        group by o.kind order by o.kind
      `,
      this.database.sql<Array<{
        sequence: string
        kind: string
        change_type: 'upsert' | 'delete'
        created_at: Date
        device_id: string
        device_name: string
        device_platform: string
      }>>`
        select c.sequence::text as sequence, v.kind::text as kind,
          c.change_type, c.created_at, d.id as device_id,
          d.name as device_name, d.platform as device_platform
        from changes c
        join workspaces w on w.id = c.workspace_id
        join object_versions v on v.workspace_id = c.workspace_id
          and v.object_id = c.object_id and v.revision = c.revision
        join devices d on d.id = c.source_device_id
        where w.account_id = ${accountId} and w.deleted_at is null
        order by c.created_at desc, c.sequence desc limit 30
      `,
    ])
    const summary = summaries[0]
    return {
      workspaceCount: summary?.workspace_count ?? 0,
      objectCount: summary?.object_count ?? 0,
      deletedObjectCount: summary?.deleted_object_count ?? 0,
      objectBytes: summary?.object_bytes ?? '0',
      blobCount: summary?.blob_count ?? 0,
      blobBytes: summary?.blob_bytes ?? '0',
      latestSequence: summary?.latest_sequence ?? '0',
      lastActivityAt: summary?.last_activity_at ?? null,
      encryptionMode: summary?.encryption_mode ?? null,
      kinds: kinds.map((item) => ({
        kind: item.kind,
        activeCount: item.active_count,
        deletedCount: item.deleted_count,
        updatedAt: item.updated_at,
      })),
      recentActivity: recentActivity.map((item) => ({
        sequence: item.sequence,
        kind: item.kind,
        changeType: item.change_type,
        createdAt: item.created_at,
        device: {
          id: item.device_id,
          name: item.device_name,
          platform: item.device_platform,
        },
      })),
    }
  }

  async listAccountWorkspaces(accountId: string) {
    const rows = await this.database.db.select({
      id: workspaces.id,
      nameCiphertext: workspaces.nameCiphertext,
      isDefault: workspaces.isDefault,
      latestSequence: workspaces.latestSequence,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    }).from(workspaces).where(and(
      eq(workspaces.accountId, accountId),
      isNull(workspaces.deletedAt),
    )).orderBy(desc(workspaces.isDefault), desc(workspaces.updatedAt))
    if (rows.length === 0) return []

    const workspaceIds = rows.map((row) => row.id)
    const [keyVersions, managedEnvelopes, objectCounts] = await Promise.all([
      this.database.db.select({
        workspaceId: workspaceKeys.workspaceId,
        latestKeyVersion: sql<number>`max(${workspaceKeys.keyVersion})::int`,
      }).from(workspaceKeys).where(inArray(workspaceKeys.workspaceId, workspaceIds))
        .groupBy(workspaceKeys.workspaceId),
      this.database.db.select({ workspaceId: workspaceKeyEnvelopes.workspaceId })
        .from(workspaceKeyEnvelopes).where(and(
          inArray(workspaceKeyEnvelopes.workspaceId, workspaceIds),
          eq(workspaceKeyEnvelopes.type, 'managed'),
        )),
      this.database.db.select({
        workspaceId: objects.workspaceId,
        objectCount: sql<number>`count(*) filter (where ${objects.deletedAt} is null)::int`,
        deletedObjectCount: sql<number>`count(*) filter (where ${objects.deletedAt} is not null)::int`,
      }).from(objects).where(inArray(objects.workspaceId, workspaceIds))
        .groupBy(objects.workspaceId),
    ])
    const latestKeyVersionByWorkspace = new Map(keyVersions.map((item) => (
      [item.workspaceId, item.latestKeyVersion] as const
    )))
    const managedWorkspaceIds = new Set(managedEnvelopes.map((item) => item.workspaceId))
    const objectCountsByWorkspace = new Map(objectCounts.map((item) => (
      [item.workspaceId, item] as const
    )))
    return rows.map((row) => ({
      ...row,
      latestSequence: row.latestSequence.toString(),
      latestKeyVersion: latestKeyVersionByWorkspace.get(row.id) ?? 0,
      encryptionMode: managedWorkspaceIds.has(row.id) ? 'managed' as const : 'e2ee' as const,
      objectCount: objectCountsByWorkspace.get(row.id)?.objectCount ?? 0,
      deletedObjectCount: objectCountsByWorkspace.get(row.id)?.deletedObjectCount ?? 0,
    }))
  }

  async listAccountWorkspaceObjects(accountId: string, workspaceId: string, input: {
    kind?: SyncObjectKind
    status: 'active' | 'deleted' | 'all'
    limit: number
    offset: number
  }) {
    await this.assertOwned(accountId, workspaceId)
    const filters = [eq(objects.workspaceId, workspaceId)]
    if (input.kind === 'record') {
      // NoteGen clients sync user-facing records as `mark` objects. Keep the
      // legacy `record` kind visible for older and admin-created test objects.
      filters.push(inArray(objects.kind, ['record', 'mark']))
    } else if (input.kind !== undefined) {
      filters.push(eq(objects.kind, input.kind))
    }
    if (input.status === 'active') filters.push(isNull(objects.deletedAt))
    if (input.status === 'deleted') filters.push(isNotNull(objects.deletedAt))

    const where = and(...filters)
    const [rows, totals] = await Promise.all([
      this.database.db.select({
        objectId: objects.objectId,
        kind: objects.kind,
        currentRevision: objects.currentRevision,
        ciphertext: objects.ciphertext,
        ciphertextHash: objects.ciphertextHash,
        keyVersion: objects.keyVersion,
        blobRefs: objects.blobRefs,
        deletedAt: objects.deletedAt,
        createdAt: objects.createdAt,
        updatedAt: objects.updatedAt,
      }).from(objects).where(where)
        .orderBy(desc(objects.updatedAt), desc(objects.objectId))
        .limit(input.limit)
        .offset(input.offset),
      this.database.db.select({ count: sql<number>`count(*)::int` }).from(objects).where(where),
    ])

    return {
      total: totals[0]?.count ?? 0,
      objects: rows.map((row) => ({
        ...row,
        currentRevision: row.currentRevision.toString(),
        ciphertextBytes: Buffer.byteLength(row.ciphertext, 'utf8').toString(),
      })),
    }
  }

  async assertOwned(accountId: string, workspaceId: string): Promise<void> {
    const [workspace] = await this.database.db.select({ id: workspaces.id }).from(workspaces).where(and(
      eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId), isNull(workspaces.deletedAt),
    )).limit(1)
    if (workspace === undefined) {
      throw new ApiError({ code: 'workspace_not_found', message: 'Workspace not found', statusCode: 404 })
    }
  }

  async listKeys(accountId: string, workspaceId: string) {
    await this.assertOwned(accountId, workspaceId)
    const keys = await this.database.db.select({
      keyVersion: workspaceKeys.keyVersion,
      createdAt: workspaceKeys.createdAt,
    }).from(workspaceKeys).where(eq(workspaceKeys.workspaceId, workspaceId))
      .orderBy(workspaceKeys.keyVersion)
    const envelopes = await this.database.db.select({
      id: workspaceKeyEnvelopes.id,
      keyVersion: workspaceKeyEnvelopes.keyVersion,
      type: workspaceKeyEnvelopes.type,
      recipientId: workspaceKeyEnvelopes.recipientId,
      wrappedKey: workspaceKeyEnvelopes.wrappedKey,
      kdfSalt: workspaceKeyEnvelopes.kdfSalt,
      kdfParams: workspaceKeyEnvelopes.kdfParams,
      createdAt: workspaceKeyEnvelopes.createdAt,
    }).from(workspaceKeyEnvelopes).where(eq(workspaceKeyEnvelopes.workspaceId, workspaceId))
    return keys.map((key) => ({
      ...key,
      envelopes: envelopes.filter((envelope) => envelope.keyVersion === key.keyVersion),
    }))
  }

  async addKey(accountId: string, workspaceId: string, input: Omit<CreateWorkspaceInput, 'nameCiphertext'>) {
    await this.assertOwned(accountId, workspaceId)
    validateKeyEnvelopes(input.envelopes, true)
    await this.#validateDeviceRecipients(accountId, input.envelopes)
    try {
      const key = await this.database.db.transaction(async (tx) => {
        const [key] = await tx.insert(workspaceKeys).values({
          workspaceId, keyVersion: input.keyVersion,
        }).returning({ keyVersion: workspaceKeys.keyVersion, createdAt: workspaceKeys.createdAt })
        if (key === undefined) throw new Error('Workspace key insert returned no row')
        await tx.insert(workspaceKeyEnvelopes).values(input.envelopes.map((envelope) => ({
          workspaceId, keyVersion: input.keyVersion, ...envelope,
        })))
        return key
      })
      await this.#publishKeysChanged(workspaceId, input.keyVersion)
      return key
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ApiError({ code: 'key_version_exists', message: 'Key version already exists', statusCode: 409 })
      }
      throw error
    }
  }

  async addEnvelope(accountId: string, workspaceId: string, keyVersion: number, envelope: KeyEnvelopeInput) {
    await this.assertOwned(accountId, workspaceId)
    validateKeyEnvelopes([envelope], false)
    await this.#validateDeviceRecipients(accountId, [envelope])
    try {
      const [created] = await this.database.db.insert(workspaceKeyEnvelopes).values({
        workspaceId, keyVersion, ...envelope,
      }).returning()
      if (created === undefined) throw new Error('Workspace key envelope insert returned no row')
      await this.#publishKeysChanged(workspaceId, keyVersion)
      return created
    } catch (error) {
      const code = databaseErrorCode(error)
      if (code === '23503') {
        throw new ApiError({ code: 'key_version_not_found', message: 'Key version not found', statusCode: 404 })
      }
      if (code === '23505') {
        throw new ApiError({ code: 'key_envelope_exists', message: 'Key envelope already exists', statusCode: 409 })
      }
      throw error
    }
  }

  async enableEndToEndEncryption(
    accountId: string,
    workspaceId: string,
    keyVersion: number,
    envelopes: KeyEnvelopeInput[],
  ): Promise<void> {
    await this.assertOwned(accountId, workspaceId)
    validateKeyEnvelopes(envelopes, true)
    if (envelopes.some((envelope) => envelope.type === 'managed' || envelope.type === 'device')) {
      throw new ApiError({
        code: 'key_envelope_invalid',
        message: 'End-to-end encryption requires passphrase and recovery envelopes only',
        statusCode: 400,
      })
    }
    await this.database.db.transaction(async (tx) => {
      const [key] = await tx.select({ keyVersion: workspaceKeys.keyVersion }).from(workspaceKeys).where(and(
        eq(workspaceKeys.workspaceId, workspaceId),
        eq(workspaceKeys.keyVersion, keyVersion),
      )).limit(1)
      if (key === undefined) {
        throw new ApiError({ code: 'key_version_not_found', message: 'Key version not found', statusCode: 404 })
      }
      await tx.delete(workspaceKeyEnvelopes).where(and(
        eq(workspaceKeyEnvelopes.workspaceId, workspaceId),
        eq(workspaceKeyEnvelopes.keyVersion, keyVersion),
      ))
      await tx.insert(workspaceKeyEnvelopes).values(envelopes.map((envelope) => ({
        workspaceId,
        keyVersion,
        ...envelope,
      })))
    })
    await this.#publishKeysChanged(workspaceId, keyVersion)
  }

  async enableManagedEncryption(
    accountId: string,
    workspaceId: string,
    keys: Array<{ keyVersion: number, managedKey: string }>,
  ): Promise<void> {
    await this.assertOwned(accountId, workspaceId)
    const versions = new Set<number>()
    for (const key of keys) {
      if (versions.has(key.keyVersion) || !/^[A-Za-z0-9_-]{43}$/.test(key.managedKey)) {
        throw new ApiError({
          code: 'managed_keys_invalid',
          message: 'Managed keys must contain one 256-bit key for every unique key version',
          statusCode: 400,
        })
      }
      versions.add(key.keyVersion)
    }

    await this.database.db.transaction(async (tx) => {
      const [workspace] = await tx.select({ isDefault: workspaces.isDefault }).from(workspaces).where(and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.accountId, accountId),
        isNull(workspaces.deletedAt),
      )).limit(1)
      if (!workspace?.isDefault) {
        throw new ApiError({
          code: 'managed_workspace_not_default',
          message: 'Managed encryption is only available for the account default workspace',
          statusCode: 409,
        })
      }
      const storedKeys = await tx.select({ keyVersion: workspaceKeys.keyVersion }).from(workspaceKeys)
        .where(eq(workspaceKeys.workspaceId, workspaceId))
      if (storedKeys.length !== keys.length
        || storedKeys.some(key => !versions.has(key.keyVersion))) {
        throw new ApiError({
          code: 'managed_keys_incomplete',
          message: 'A managed key is required for every workspace key version',
          statusCode: 409,
        })
      }
      await tx.delete(workspaceKeyEnvelopes).where(eq(workspaceKeyEnvelopes.workspaceId, workspaceId))
      await tx.insert(workspaceKeyEnvelopes).values(keys.map(key => ({
        workspaceId,
        keyVersion: key.keyVersion,
        type: 'managed' as const,
        recipientId: null,
        wrappedKey: key.managedKey,
        kdfSalt: null,
        kdfParams: null,
      })))
    })
    await Promise.all(keys.map(key => this.#publishKeysChanged(workspaceId, key.keyVersion)))
  }

  async remove(
    accountId: string,
    workspaceId: string,
    options: { allowDefault?: boolean } = {},
  ): Promise<void> {
    await this.assertOwned(accountId, workspaceId)
    const [removed] = await this.database.db.update(workspaces)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.accountId, accountId),
        ...(options.allowDefault === false ? [eq(workspaces.isDefault, false)] : []),
      ))
      .returning({ id: workspaces.id })
    if (removed === undefined) {
      throw new ApiError({
        code: 'workspace_default_delete_forbidden',
        message: 'The default workspace cannot be deleted from the web portal',
        statusCode: 409,
      })
    }
    await this.notifier.publish({
      type: 'workspace.state-changed', workspaceId, deleted: true,
    }).catch(() => undefined)
    await this.#publishWorkspaceListChanged(accountId)
  }

  async restore(accountId: string, workspaceId: string): Promise<void> {
    let restored: { id: string } | undefined
    try {
      [restored] = await this.database.db.update(workspaces).set({
        deletedAt: null,
        updatedAt: new Date(),
      }).where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
        .returning({ id: workspaces.id })
    } catch (error) {
      if (databaseErrorCode(error) === '23505') {
        throw new ApiError({
          code: 'workspace_default_conflict',
          message: 'Another active default workspace already exists',
          statusCode: 409,
        })
      }
      throw error
    }
    if (restored === undefined) {
      throw new ApiError({ code: 'workspace_not_found', message: 'Workspace not found', statusCode: 404 })
    }
    await this.notifier.publish({
      type: 'workspace.state-changed', workspaceId, deleted: false,
    }).catch(() => undefined)
    await this.#publishWorkspaceListChanged(accountId)
  }

  async #publishKeysChanged(workspaceId: string, keyVersion: number): Promise<void> {
    await this.notifier.publish({
      type: 'workspace.keys-changed', workspaceId, keyVersion,
    }).catch(() => undefined)
  }

  async #publishWorkspaceListChanged(accountId: string): Promise<void> {
    await this.notifier.publish({ type: 'account.workspaces-changed', accountId }).catch(() => undefined)
  }

  async #validateDeviceRecipients(accountId: string, envelopes: KeyEnvelopeInput[]): Promise<void> {
    const recipientIds = envelopes.flatMap((envelope) => (
      envelope.type === 'device' && envelope.recipientId !== null ? [envelope.recipientId] : []
    ))
    if (recipientIds.length === 0) return
    if (recipientIds.some((recipientId) => !uuidPattern.test(recipientId))) {
      throw new ApiError({
        code: 'key_envelope_recipient_not_found',
        message: 'Device key envelope recipient is invalid',
        statusCode: 400,
      })
    }
    const recipients = await this.database.db.select({ id: devices.id }).from(devices).where(and(
      eq(devices.accountId, accountId), isNull(devices.revokedAt), inArray(devices.id, recipientIds),
    ))
    if (recipients.length !== new Set(recipientIds).size) {
      throw new ApiError({
        code: 'key_envelope_recipient_not_found',
        message: 'Device key envelope recipient is missing or revoked',
        statusCode: 400,
      })
    }
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validateKeyEnvelopes(
  envelopes: KeyEnvelopeInput[],
  requireRecovery: boolean,
  allowManaged = false,
): void {
  if (requireRecovery && (!envelopes.some((item) => item.type === 'passphrase')
    || !envelopes.some((item) => item.type === 'recovery'))) {
    throw new ApiError({
      code: 'key_envelopes_incomplete',
      message: 'A key version requires passphrase and recovery envelopes',
      statusCode: 400,
    })
  }
  const recipients = new Set<string>()
  for (const envelope of envelopes) {
    if (envelope.type === 'managed' && !allowManaged) {
      throw new ApiError({
        code: 'key_envelope_invalid',
        message: 'Managed envelopes can only be created for the account default workspace',
        statusCode: 400,
      })
    }
    if (envelope.type === 'device' && envelope.recipientId === null) {
      throw new ApiError({ code: 'key_envelope_invalid', message: 'Device envelope requires recipientId', statusCode: 400 })
    }
    if (envelope.type !== 'device' && envelope.recipientId !== null) {
      throw new ApiError({ code: 'key_envelope_invalid', message: 'Only device envelopes accept recipientId', statusCode: 400 })
    }
    if (envelope.type === 'passphrase' && (envelope.kdfSalt === null || envelope.kdfParams === null)) {
      throw new ApiError({ code: 'key_envelope_invalid', message: 'Passphrase envelope requires KDF parameters', statusCode: 400 })
    }
    if (envelope.type === 'managed' && (envelope.kdfSalt !== null || envelope.kdfParams !== null)) {
      throw new ApiError({ code: 'key_envelope_invalid', message: 'Managed envelope cannot use KDF parameters', statusCode: 400 })
    }
    if (envelope.kdfParams !== null) {
      const values = Object.values(envelope.kdfParams)
      if (values.length === 0 || values.length > 20
        || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw new ApiError({
          code: 'key_envelope_invalid',
          message: 'KDF parameters must contain positive integer values',
          statusCode: 400,
        })
      }
    }
    const recipient = `${envelope.type}:${envelope.recipientId ?? ''}`
    if (recipients.has(recipient)) {
      throw new ApiError({ code: 'key_envelope_duplicate', message: 'Key envelopes contain a duplicate recipient', statusCode: 400 })
    }
    recipients.add(recipient)
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
