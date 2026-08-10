import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import {
  adminTestObjects, blobs, bootstrapSessions, changes, deviceCursors, devices, objectVersions, objects, operations,
  workspaceKeyEnvelopes, workspaceKeys, workspaces,
} from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { WorkspaceService } from '../workspaces/service.js'
import type { ChangeNotifier, PushOperationInput, SyncObjectKind } from './types.js'

export class SyncService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: ChangeNotifier,
    private readonly maxObjectBytes: number,
  ) {}

  async push(accountId: string, deviceId: string, workspaceId: string, inputs: PushOperationInput[]) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const results = []
    for (const input of inputs) {
      try {
        results.push(await this.#pushOne(accountId, deviceId, workspaceId, input))
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        results.push({
          operationId: input.operationId,
          status: 'rejected' as const,
          code: error.code,
          retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details }),
        })
      }
    }
    return { results }
  }

  async createWebTestObject(
    accountId: string,
    workspaceId: string,
    kind: Extract<SyncObjectKind, 'note' | 'record' | 'canvas' | 'setting'>,
  ) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const [envelope] = await this.database.db.select({
      keyVersion: workspaceKeyEnvelopes.keyVersion,
      wrappedKey: workspaceKeyEnvelopes.wrappedKey,
    }).from(workspaceKeyEnvelopes).where(and(
      eq(workspaceKeyEnvelopes.workspaceId, workspaceId),
      eq(workspaceKeyEnvelopes.type, 'managed'),
    )).orderBy(desc(workspaceKeyEnvelopes.keyVersion)).limit(1)
    if (envelope === undefined) {
      throw new ApiError({
        code: 'web_test_data_managed_only',
        message: 'Test data can only be generated in a managed workspace',
        statusCode: 409,
      })
    }

    const key = Buffer.from(envelope.wrappedKey, 'base64url')
    if (key.byteLength !== 32) {
      throw new ApiError({
        code: 'managed_key_invalid',
        message: 'Managed workspace key is invalid',
        statusCode: 409,
      })
    }
    const testId = randomUUID()
    const testObject = webTestPayload(kind, testId)
    const objectId = deterministicObjectId(workspaceId, kind, testObject.logicalKey)
    const payload = testObject.payload
    const ciphertext = encryptManagedPayload(key, payload)
    const ciphertextHash = createHash('sha256').update(Buffer.from(ciphertext, 'base64url')).digest('base64url')
    const sourceDeviceId = await this.#webSourceDeviceId(accountId)
    const result = await this.#pushOne(accountId, sourceDeviceId, workspaceId, {
      operationId: randomUUID(),
      objectId,
      kind,
      baseRevision: null,
      keyVersion: envelope.keyVersion,
      ciphertext,
      ciphertextHash,
      blobRefs: [],
      delete: false,
    })
    if (result.status !== 'applied') {
      throw new ApiError({ code: 'web_test_data_conflict', message: 'Test object could not be created', statusCode: 409 })
    }
    await this.database.db.insert(adminTestObjects).values({
      workspaceId, objectId, kind, createdByAccountId: accountId,
    }).onConflictDoNothing()
    return { objectId, revision: result.revision, sequence: result.sequence }
  }

  async listWebTestObjects(accountId: string, workspaceId: string) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    return this.database.db.select({
      objectId: adminTestObjects.objectId,
      kind: adminTestObjects.kind,
      createdAt: adminTestObjects.createdAt,
      deletedAt: objects.deletedAt,
    }).from(adminTestObjects).innerJoin(objects, and(
      eq(objects.workspaceId, adminTestObjects.workspaceId),
      eq(objects.objectId, adminTestObjects.objectId),
    )).where(eq(adminTestObjects.workspaceId, workspaceId)).orderBy(desc(adminTestObjects.createdAt))
  }

  async cleanupWebTestObjects(accountId: string, workspaceId: string): Promise<{ deleted: number, skipped: number }> {
    const candidates = await this.listWebTestObjects(accountId, workspaceId)
    let deleted = 0
    let skipped = 0
    for (const candidate of candidates) {
      if (candidate.deletedAt !== null) {
        skipped += 1
        continue
      }
      try {
        await this.deleteWebObject(accountId, workspaceId, candidate.objectId)
        deleted += 1
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode >= 500) throw error
        skipped += 1
      }
    }
    return { deleted, skipped }
  }

  async deleteWebObject(accountId: string, workspaceId: string, objectId: string) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const [current] = await this.database.db.select({
      kind: objects.kind,
      currentRevision: objects.currentRevision,
      ciphertext: objects.ciphertext,
      ciphertextHash: objects.ciphertextHash,
      keyVersion: objects.keyVersion,
      blobRefs: objects.blobRefs,
      deletedAt: objects.deletedAt,
    }).from(objects).where(and(
      eq(objects.workspaceId, workspaceId),
      eq(objects.objectId, objectId),
    )).limit(1)
    if (current === undefined) {
      throw new ApiError({ code: 'object_not_found', message: 'Object not found', statusCode: 404 })
    }
    if (current.deletedAt !== null) {
      throw new ApiError({ code: 'object_already_deleted', message: 'Object is already deleted', statusCode: 409 })
    }

    const [envelope] = await this.database.db.select({ wrappedKey: workspaceKeyEnvelopes.wrappedKey })
      .from(workspaceKeyEnvelopes).where(and(
        eq(workspaceKeyEnvelopes.workspaceId, workspaceId),
        eq(workspaceKeyEnvelopes.keyVersion, current.keyVersion),
        eq(workspaceKeyEnvelopes.type, 'managed'),
      )).limit(1)
    if (envelope === undefined) {
      throw new ApiError({
        code: 'web_object_delete_managed_only',
        message: 'Web deletion is only available for managed workspace objects',
        statusCode: 409,
      })
    }
    const key = Buffer.from(envelope.wrappedKey, 'base64url')
    let ciphertext = current.ciphertext
    let ciphertextHash = current.ciphertextHash
    if (current.kind === 'canvas' || current.kind === 'setting') {
      const payload = decryptManagedPayload(key, current.ciphertext)
      const logicalKey = logicalKeyForWebDeletion(current.kind, payload)
      ciphertext = encryptManagedPayload(key, {
        schemaVersion: 1,
        type: 'delete',
        kind: current.kind,
        logicalKey,
        deletedAt: Date.now(),
      })
      ciphertextHash = createHash('sha256').update(Buffer.from(ciphertext, 'base64url')).digest('base64url')
    }

    const sourceDeviceId = await this.#webSourceDeviceId(accountId)
    const result = await this.#pushOne(accountId, sourceDeviceId, workspaceId, {
      operationId: randomUUID(),
      objectId,
      kind: current.kind,
      baseRevision: current.currentRevision.toString(),
      keyVersion: current.keyVersion,
      ciphertext,
      ciphertextHash,
      blobRefs: current.blobRefs,
      delete: true,
    })
    if (result.status !== 'applied') {
      throw new ApiError({ code: 'object_delete_conflict', message: 'Object changed before deletion', statusCode: 409 })
    }
    return { revision: result.revision, sequence: result.sequence }
  }

  async #webSourceDeviceId(accountId: string): Promise<string> {
    const [device] = await this.database.db.select({ id: devices.id }).from(devices).where(and(
      eq(devices.accountId, accountId),
      isNull(devices.revokedAt),
    )).orderBy(desc(devices.lastSeenAt)).limit(1)
    if (device === undefined) {
      throw new ApiError({
        code: 'web_mutation_device_required',
        message: 'Connect an active NoteGen device before changing sync data from the web portal',
        statusCode: 409,
      })
    }
    return device.id
  }

  async #pushOne(accountId: string, deviceId: string, workspaceId: string, input: PushOperationInput) {
    const ciphertextBytes = decodeBase64Url(input.ciphertext)
    if (ciphertextBytes.byteLength > this.maxObjectBytes) {
      throw new ApiError({ code: 'object_too_large', message: 'Object exceeds the configured limit', statusCode: 413 })
    }
    const ciphertextHash = createHash('sha256').update(ciphertextBytes).digest('base64url')
    if (ciphertextHash !== input.ciphertextHash) {
      throw new ApiError({
        code: 'ciphertext_hash_mismatch',
        message: 'Object ciphertext hash does not match its payload',
        statusCode: 422,
      })
    }
    const requestHash = hashOperation(input)
    const result = await this.database.db.transaction(async (tx) => {
      // Serialize mutations at workspace granularity. Locking only the object row is
      // insufficient for the first write because no row exists yet, and it also
      // lets an idempotent retry overtake the transaction that records its result.
      const [lockedWorkspace] = await tx.select({ id: workspaces.id }).from(workspaces)
        .where(and(
          eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId), isNull(workspaces.deletedAt),
        )).limit(1).for('update')
      if (lockedWorkspace === undefined) {
        throw new ApiError({ code: 'workspace_not_found', message: 'Workspace not found', statusCode: 404 })
      }

      const [previous] = await tx.select({
        revision: operations.resultRevision,
        sequence: operations.resultSequence,
        requestHash: operations.requestHash,
      }).from(operations).where(and(
        eq(operations.workspaceId, workspaceId), eq(operations.operationId, input.operationId),
      )).limit(1)
      if (previous !== undefined) {
        if (previous.requestHash !== null && previous.requestHash !== requestHash) {
          throw new ApiError({
            code: 'operation_id_reused',
            message: 'Operation ID was already used for a different payload',
            statusCode: 409,
          })
        }
        return {
          operationId: input.operationId,
          status: 'applied' as const,
          revision: previous.revision.toString(),
          sequence: previous.sequence.toString(),
          duplicate: true,
        }
      }

      const [current] = await tx.select().from(objects).where(and(
        eq(objects.workspaceId, workspaceId), eq(objects.objectId, input.objectId),
      )).limit(1)
      const expected = input.baseRevision === null ? null : parseCounter(input.baseRevision, 'baseRevision')
      const actual = current?.currentRevision ?? null
      if (actual !== expected) {
        return {
          operationId: input.operationId,
          status: 'conflict' as const,
          code: 'revision_conflict' as const,
          current: current === undefined ? null : serializeObject(current),
        }
      }

      const [workspaceKey] = await tx.select({ keyVersion: workspaceKeys.keyVersion }).from(workspaceKeys)
        .where(and(
          eq(workspaceKeys.workspaceId, workspaceId),
          eq(workspaceKeys.keyVersion, input.keyVersion),
        )).limit(1)
      if (workspaceKey === undefined) {
        throw new ApiError({ code: 'key_version_not_found', message: 'Workspace key version not found', statusCode: 409 })
      }

      if (input.blobRefs.length > 0) {
        const ready = await tx.select({ id: blobs.blobId }).from(blobs).where(and(
          eq(blobs.workspaceId, workspaceId), eq(blobs.state, 'ready'), inArray(blobs.blobId, input.blobRefs),
        ))
        if (ready.length !== new Set(input.blobRefs).size) {
          throw new ApiError({
            code: 'blob_not_ready', message: 'One or more blobs are not ready', statusCode: 409, retryable: true,
          })
        }
      }

      const revision = (actual ?? 0n) + 1n
      const [sequenceRow] = await tx.update(workspaces).set({
        latestSequence: sql`${workspaces.latestSequence} + 1`,
        updatedAt: new Date(),
      }).where(eq(workspaces.id, workspaceId)).returning({ sequence: workspaces.latestSequence })
      if (sequenceRow === undefined) throw new Error('Workspace sequence update returned no row')
      const sequence = sequenceRow.sequence
      const deletedAt = input.delete ? new Date() : null

      await tx.insert(objectVersions).values({
        workspaceId, objectId: input.objectId, revision, sequence, kind: input.kind,
        ciphertext: input.ciphertext, ciphertextHash: input.ciphertextHash,
        keyVersion: input.keyVersion, blobRefs: input.blobRefs,
        sourceDeviceId: deviceId, deleted: input.delete,
      })
      await tx.insert(objects).values({
        workspaceId, objectId: input.objectId, kind: input.kind, currentRevision: revision,
        ciphertext: input.ciphertext, ciphertextHash: input.ciphertextHash,
        keyVersion: input.keyVersion, blobRefs: input.blobRefs, deletedAt,
      }).onConflictDoUpdate({
        target: [objects.workspaceId, objects.objectId],
        set: {
          kind: input.kind, currentRevision: revision, ciphertext: input.ciphertext,
          ciphertextHash: input.ciphertextHash, keyVersion: input.keyVersion,
          blobRefs: input.blobRefs, deletedAt, updatedAt: new Date(),
        },
      })
      await tx.insert(changes).values({
        workspaceId, sequence, objectId: input.objectId, revision,
        operationId: input.operationId, sourceDeviceId: deviceId,
        type: input.delete ? 'delete' : 'upsert',
      })
      await tx.insert(operations).values({
        workspaceId, operationId: input.operationId, sourceDeviceId: deviceId,
        requestHash, resultRevision: revision, resultSequence: sequence,
      })
      if (input.blobRefs.length > 0) {
        await tx.update(blobs).set({ lastReferencedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(blobs.workspaceId, workspaceId), inArray(blobs.blobId, input.blobRefs),
        ))
      }

      return {
        operationId: input.operationId,
        status: 'applied' as const,
        revision: revision.toString(),
        sequence: sequence.toString(),
        duplicate: false,
      }
    })

    if (result.status === 'applied' && !result.duplicate) {
      await this.notifier.publish({
        type: 'workspace.changed', workspaceId, latestSequence: result.sequence,
      }).catch(() => undefined)
    }
    return result
  }

  async pull(accountId: string, workspaceId: string, after: string, limit: number) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const cursor = parseCounter(after, 'cursor')
    await this.#assertCursorAvailable(workspaceId, cursor)
    const rows = await this.database.db.select({
      sequence: changes.sequence,
      objectId: changes.objectId,
      revision: changes.revision,
      operationId: changes.operationId,
      sourceDeviceId: changes.sourceDeviceId,
      changeType: changes.type,
      kind: objectVersions.kind,
      ciphertext: objectVersions.ciphertext,
      ciphertextHash: objectVersions.ciphertextHash,
      keyVersion: objectVersions.keyVersion,
      blobRefs: objectVersions.blobRefs,
      deleted: objectVersions.deleted,
      createdAt: changes.createdAt,
    }).from(changes).innerJoin(objectVersions, and(
      eq(objectVersions.workspaceId, changes.workspaceId),
      eq(objectVersions.objectId, changes.objectId),
      eq(objectVersions.revision, changes.revision),
    )).where(and(eq(changes.workspaceId, workspaceId), gt(changes.sequence, cursor)))
      .orderBy(asc(changes.sequence)).limit(limit + 1)

    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).map((row) => ({
      ...row,
      sequence: row.sequence.toString(),
      revision: row.revision.toString(),
    }))
    const [workspace] = await this.database.db.select({ latest: workspaces.latestSequence })
      .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return {
      changes: page,
      nextCursor: page.at(-1)?.sequence ?? after,
      hasMore,
      latestSequence: (workspace?.latest ?? cursor).toString(),
    }
  }

  async session(accountId: string, workspaceId: string, cursor: string) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const parsed = parseCounter(cursor, 'cursor')
    const [workspace] = await this.database.db.select({ latest: workspaces.latestSequence })
      .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    const cursorExpired = await this.#isCursorExpired(workspaceId, parsed)
    return {
      latestSequence: (workspace?.latest ?? 0n).toString(),
      cursorValid: !cursorExpired,
      bootstrapRequired: cursorExpired,
      webSocketPath: '/v1/sync/events',
    }
  }

  async acknowledge(accountId: string, deviceId: string, workspaceId: string, cursor: string): Promise<void> {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const sequence = parseCounter(cursor, 'cursor')
    const [workspace] = await this.database.db.select({ latest: workspaces.latestSequence })
      .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (workspace === undefined || sequence > workspace.latest) {
      throw new ApiError({ code: 'cursor_invalid', message: 'Cursor exceeds the workspace sequence', statusCode: 400 })
    }
    await this.database.db.insert(deviceCursors).values({
      workspaceId, deviceId, acknowledgedSequence: sequence,
    }).onConflictDoUpdate({
      target: [deviceCursors.workspaceId, deviceCursors.deviceId],
      set: {
        acknowledgedSequence: sql`greatest(${deviceCursors.acknowledgedSequence}, ${sequence})`,
        updatedAt: new Date(),
      },
    })
  }

  async bootstrap(
    accountId: string,
    deviceId: string,
    workspaceId: string,
    afterId: string | null,
    limit: number,
    requestedSessionId: string | null,
  ) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    let bootstrapSessionId: string
    let snapshot: bigint
    if (afterId === null) {
      if (requestedSessionId !== null) {
        throw new ApiError({ code: 'bootstrap_session_invalid', message: 'First bootstrap page cannot reuse a session', statusCode: 400 })
      }
      const [workspace] = await this.database.db.select({ latest: workspaces.latestSequence })
        .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
      snapshot = workspace?.latest ?? 0n
      const [session] = await this.database.db.insert(bootstrapSessions).values({
        workspaceId,
        deviceId,
        snapshotSequence: snapshot,
        expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
      }).returning({ id: bootstrapSessions.id })
      if (session === undefined) throw new Error('Bootstrap session insert returned no row')
      bootstrapSessionId = session.id
    } else {
      if (requestedSessionId === null) {
        throw new ApiError({ code: 'bootstrap_session_required', message: 'Next bootstrap page requires its session ID', statusCode: 400 })
      }
      const [session] = await this.database.db.select({
        id: bootstrapSessions.id,
        snapshotSequence: bootstrapSessions.snapshotSequence,
      }).from(bootstrapSessions).where(and(
        eq(bootstrapSessions.id, requestedSessionId),
        eq(bootstrapSessions.workspaceId, workspaceId),
        eq(bootstrapSessions.deviceId, deviceId),
        gt(bootstrapSessions.expiresAt, new Date()),
      )).limit(1)
      if (session === undefined) {
        throw new ApiError({ code: 'bootstrap_session_expired', message: 'Bootstrap session is missing or expired', statusCode: 410 })
      }
      bootstrapSessionId = session.id
      snapshot = session.snapshotSequence
    }
    const rawRows = await this.database.sql`
      select distinct on (v.object_id)
        v.object_id, v.revision, v.kind, v.ciphertext, v.ciphertext_hash,
        v.key_version, v.blob_refs, v.deleted, v.created_at
      from object_versions v
      where v.workspace_id = ${workspaceId}
        and v.sequence <= ${snapshot.toString()}::bigint
        and (${afterId}::uuid is null or v.object_id > ${afterId}::uuid)
      order by v.object_id asc, v.revision desc
      limit ${limit + 1}`
    const rows = rawRows as unknown as BootstrapRow[]
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).map((row) => ({
      objectId: row.object_id,
      currentRevision: String(row.revision),
      kind: row.kind,
      ciphertext: row.ciphertext,
      ciphertextHash: row.ciphertext_hash,
      keyVersion: row.key_version,
      blobRefs: row.blob_refs,
      deletedAt: row.deleted ? row.created_at : null,
    }))
    if (!hasMore) {
      await this.database.db.delete(bootstrapSessions).where(eq(bootstrapSessions.id, bootstrapSessionId))
    }
    return {
      objects: page,
      nextObjectId: hasMore ? page.at(-1)?.objectId ?? null : null,
      hasMore,
      snapshotSequence: snapshot.toString(),
      bootstrapSessionId: hasMore ? bootstrapSessionId : null,
    }
  }

  async history(accountId: string, workspaceId: string, objectId: string, limit: number) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const rows = await this.database.db.select().from(objectVersions).where(and(
      eq(objectVersions.workspaceId, workspaceId), eq(objectVersions.objectId, objectId),
    )).orderBy(sql`${objectVersions.revision} desc`).limit(limit)
    return rows.map((row) => ({
      ...row,
      revision: row.revision.toString(),
      sequence: row.sequence.toString(),
    }))
  }

  async restore(
    accountId: string,
    deviceId: string,
    workspaceId: string,
    objectId: string,
    revision: string,
    operationId: string,
    baseRevision: string,
  ) {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const sourceRevision = parseCounter(revision, 'revision')
    const [source] = await this.database.db.select().from(objectVersions).where(and(
      eq(objectVersions.workspaceId, workspaceId),
      eq(objectVersions.objectId, objectId),
      eq(objectVersions.revision, sourceRevision),
    )).limit(1)
    if (source === undefined) {
      throw new ApiError({ code: 'version_not_found', message: 'Historical version not found', statusCode: 404 })
    }
    const pushed = await this.push(accountId, deviceId, workspaceId, [{
      operationId,
      objectId,
      kind: source.kind,
      baseRevision,
      keyVersion: source.keyVersion,
      ciphertext: source.ciphertext,
      ciphertextHash: source.ciphertextHash,
      blobRefs: source.blobRefs,
      delete: source.deleted,
    }])
    return pushed.results[0]
  }

  async #assertCursorAvailable(workspaceId: string, cursor: bigint): Promise<void> {
    if (await this.#isCursorExpired(workspaceId, cursor)) {
      throw new ApiError({ code: 'cursor_expired', message: 'Cursor is outside the retained change log', statusCode: 410 })
    }
  }

  async #isCursorExpired(workspaceId: string, cursor: bigint): Promise<boolean> {
    const [workspace] = await this.database.db.select({ latest: workspaces.latestSequence })
      .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    const latest = workspace?.latest ?? 0n
    if (cursor > latest) {
      throw new ApiError({ code: 'cursor_invalid', message: 'Cursor exceeds the workspace sequence', statusCode: 400 })
    }
    const [row] = await this.database.db.select({ first: sql<bigint | null>`min(${changes.sequence})` })
      .from(changes).where(eq(changes.workspaceId, workspaceId))
    const first = row?.first === null || row?.first === undefined ? null : BigInt(row.first)
    return first === null ? cursor < latest : cursor < first - 1n
  }
}

interface BootstrapRow {
  object_id: string
  revision: bigint | string
  kind: typeof objectKindValues[number]
  ciphertext: string
  ciphertext_hash: string
  key_version: number
  blob_refs: string[]
  deleted: boolean
  created_at: Date
}

const objectKindValues = [
  'note', 'folder', 'asset', 'canvas', 'record', 'tag', 'mark', 'conversation',
  'memory', 'setting', 'yjs-checkpoint', 'yjs-update',
] as const

function webTestPayload(
  kind: Extract<SyncObjectKind, 'note' | 'record' | 'canvas' | 'setting'>,
  testId: string,
): { logicalKey: string, payload: Record<string, unknown> } {
  const shortId = testId.slice(0, 8)
  const createdAt = new Date().toISOString()
  const metadata = { __noteGenAdminTest: true, createdAt, source: 'web-admin' }
  if (kind === 'note') {
    const relativePath = `后台测试笔记-${shortId}.md`
    return {
      logicalKey: relativePath,
      payload: {
        schemaVersion: 1,
        type: 'markdown-note',
        relativePath,
        content: `# 后台测试笔记\n\n这是由 NoteGen 同步管理后台生成的测试内容。\n\n对象：${shortId}`,
        modifiedAt: createdAt,
        ...metadata,
      },
    }
  }
  if (kind === 'record') {
    return {
      logicalKey: `record:${testId}`,
      payload: {
        schemaVersion: 1,
        type: 'admin-test-record',
        title: `后台测试记录 ${shortId}`,
        text: '用于验证记录同步、展示和删除流程。',
        ...metadata,
      },
    }
  }
  if (kind === 'canvas') {
    return {
      logicalKey: `canvas:${testId}`,
      payload: {
        schemaVersion: 1,
        type: 'canvas',
        value: {
          id: testId,
          title: `后台测试绘图 ${shortId}`,
          canvasType: 'blank',
          schemaVersion: 1,
          document: {
            schemaVersion: 1,
            nodes: [],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            settings: { layoutDirection: 'TB', showGrid: true, snapToGrid: false },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pinnedAt: null,
          deletedAt: null,
        },
        ...metadata,
      },
    }
  }
  return {
    logicalKey: `setting:admin.test.${shortId}`,
    payload: {
      schemaVersion: 1,
      type: 'connection-test',
      key: `admin.test.${shortId}`,
      value: true,
      description: '后台测试配置（客户端会忽略）',
      ...metadata,
    },
  }
}

function deterministicObjectId(workspaceId: string, kind: string, logicalKey: string): string {
  const digest = createHash('sha256').update(`${workspaceId}\0${kind}\0${logicalKey}`).digest().subarray(0, 16)
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function encryptManagedPayload(key: Buffer, payload: Record<string, unknown>): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')
}

function decryptManagedPayload(key: Buffer, ciphertext: string): Record<string, unknown> {
  try {
    if (key.byteLength !== 32) throw new Error('invalid key')
    const bytes = Buffer.from(ciphertext, 'base64url')
    if (bytes.byteLength <= 28) throw new Error('invalid ciphertext')
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(bytes.byteLength - 16))
    const plaintext = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.byteLength - 16)),
      decipher.final(),
    ])
    const payload = JSON.parse(plaintext.toString('utf8')) as unknown
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('invalid payload')
    return payload as Record<string, unknown>
  } catch {
    throw new ApiError({
      code: 'web_object_payload_invalid',
      message: 'Object payload could not be decrypted for safe deletion',
      statusCode: 409,
    })
  }
}

function logicalKeyForWebDeletion(kind: 'canvas' | 'setting', payload: Record<string, unknown>): string {
  if (kind === 'setting' && typeof payload.key === 'string' && payload.key.length > 0) {
    return `setting:${payload.key}`
  }
  if (kind === 'canvas' && typeof payload.value === 'object' && payload.value !== null
    && !Array.isArray(payload.value) && typeof (payload.value as Record<string, unknown>).id === 'string') {
    return `canvas:${(payload.value as Record<string, unknown>).id as string}`
  }
  throw new ApiError({
    code: 'web_object_payload_invalid',
    message: 'Object payload does not contain a stable identity for deletion',
    statusCode: 409,
  })
}

function parseCounter(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new ApiError({ code: 'request_invalid', message: `${field} must be an unsigned integer string`, statusCode: 400 })
  }
  const parsed = BigInt(value)
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new ApiError({ code: 'request_invalid', message: `${field} exceeds the supported range`, statusCode: 400 })
  }
  return parsed
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError({ code: 'request_invalid', message: 'Ciphertext must use unpadded Base64URL', statusCode: 400 })
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) {
    throw new ApiError({ code: 'request_invalid', message: 'Ciphertext Base64URL is not canonical', statusCode: 400 })
  }
  return decoded
}

function hashOperation(input: PushOperationInput): string {
  return createHash('sha256').update(JSON.stringify({
    objectId: input.objectId,
    kind: input.kind,
    baseRevision: input.baseRevision,
    keyVersion: input.keyVersion,
    ciphertext: input.ciphertext,
    ciphertextHash: input.ciphertextHash,
    blobRefs: input.blobRefs,
    delete: input.delete,
  })).digest('base64url')
}

function serializeObject(row: typeof objects.$inferSelect) {
  return { ...row, currentRevision: row.currentRevision.toString() }
}
