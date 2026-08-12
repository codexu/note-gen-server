import { createHash } from 'node:crypto'
import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import {
  blobs, objectVersions, objects, syncBootstrapObjects, syncBootstrapSessions,
  syncCheckpoints, syncCommands, syncConflicts, syncDocuments, syncEvents,
  syncResourceBindings, syncUpdates, workspaceKeys, workspaces,
} from '../database/schema.js'
import { ApiError } from '../errors.js'
import { assertAccountWriteAllowedInTransaction } from '../compliance/deletion-fence.js'
import type { ChangeNotifier } from '../sync/types.js'
import type { WorkspaceService } from '../workspaces/service.js'
import type { CiphertextEnvelope, SyncCommand, SyncCommandResult } from './types.js'
import type { UsageService } from '../usage/service.js'

export class DurableSyncService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly workspaces: WorkspaceService,
    private readonly notifier: ChangeNotifier,
    private readonly maxObjectBytes: number | (() => number),
    private readonly usage?: UsageService,
    private readonly storageLimitResolver?: (accountId: string) => Promise<bigint | null>,
    private readonly syncEpoch?: string,
  ) {}

  async commands(accountId: string, deviceId: string, workspaceId: string, commands: SyncCommand[], expectedSyncEpoch?: string) {
    this.#assertSyncEpoch(expectedSyncEpoch)
    await this.workspaces.assertOwned(accountId, workspaceId)
    const results: SyncCommandResult[] = []
    for (const command of commands) {
      try {
        results.push(await this.#command(accountId, deviceId, workspaceId, command))
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        results.push({
          commandId: command.commandId,
          status: 'rejected', duplicate: false, code: error.code, retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details }),
        })
      }
    }
    return { results }
  }

  async recordCommandIngress(accountId: string, workspaceId: string, bytes: bigint, requestId: string): Promise<void> {
    await this.usage?.recordSyncCommandIngress({ accountId, workspaceId, bytes, requestId })
  }

  async events(accountId: string, workspaceId: string, after: string, limit: number, expectedSyncEpoch?: string) {
    this.#assertSyncEpoch(expectedSyncEpoch)
    await this.workspaces.assertOwned(accountId, workspaceId)
    const cursor = counter(after, 'after')
    const rows = await this.database.db.select().from(syncEvents).where(and(
      eq(syncEvents.workspaceId, workspaceId), gt(syncEvents.sequence, cursor),
    )).orderBy(asc(syncEvents.sequence)).limit(limit + 1)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).map(serializeEvent)
    const [workspace] = await this.database.db.select({ latestSequence: workspaces.latestSequence })
      .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return {
      events: page,
      nextCursor: page.at(-1)?.sequence ?? after,
      latestSequence: (workspace?.latestSequence ?? cursor).toString(),
      hasMore,
    }
  }

  async objectVersion(
    accountId: string,
    workspaceId: string,
    objectId: string,
    revisionValue: string,
    expectedSyncEpoch?: string,
  ) {
    this.#assertSyncEpoch(expectedSyncEpoch)
    await this.workspaces.assertOwned(accountId, workspaceId)
    const revision = counter(revisionValue, 'revision')
    const [version] = await this.database.db.select().from(objectVersions).where(and(
      eq(objectVersions.workspaceId, workspaceId),
      eq(objectVersions.objectId, objectId),
      eq(objectVersions.revision, revision),
    )).limit(1)
    if (!version) throw new ApiError({ code: 'object_version_not_found', message: 'Object version not found', statusCode: 404 })
    const bindings = await this.database.db.select().from(syncResourceBindings).where(and(
      eq(syncResourceBindings.workspaceId, workspaceId),
      eq(syncResourceBindings.ownerObjectId, objectId),
      eq(syncResourceBindings.ownerRevision, revision),
    ))
    const resourceRows = bindings.length === 0 ? []
      : await this.database.db.select({ version: objectVersions })
          .from(syncResourceBindings)
          .innerJoin(objectVersions, and(
            eq(objectVersions.workspaceId, syncResourceBindings.workspaceId),
            eq(objectVersions.objectId, syncResourceBindings.resourceObjectId),
            eq(objectVersions.revision, syncResourceBindings.resourceRevision),
          )).where(and(
            eq(syncResourceBindings.workspaceId, workspaceId),
            eq(syncResourceBindings.ownerObjectId, objectId),
            eq(syncResourceBindings.ownerRevision, revision),
          ))
    if (resourceRows.length !== bindings.length) throw new ApiError({
      code: 'resource_version_missing',
      message: 'A resource version required by this object history is missing',
      statusCode: 409,
    })
    const historicalObjectIds = [objectId, ...resourceRows.map(row => row.version.objectId)]
    const currentRows = await this.database.db.select({
      objectId: objects.objectId,
      currentRevision: objects.currentRevision,
    }).from(objects).where(and(
      eq(objects.workspaceId, workspaceId),
      inArray(objects.objectId, historicalObjectIds),
    ))
    const currentRevisions = new Map(currentRows.map(row => [row.objectId, row.currentRevision.toString()]))
    const withCurrentRevision = (row: typeof objectVersions.$inferSelect) => ({
      ...serializeObjectVersion(row),
      currentRevision: currentRevisions.get(row.objectId) ?? null,
    })
    const resources = resourceRows.map(row => withCurrentRevision(row.version))
    return { object: withCurrentRevision(version), resources }
  }

  async objectVersions(
    accountId: string,
    workspaceId: string,
    objectId: string,
    beforeValue: string | null,
    limit: number,
    expectedSyncEpoch?: string,
  ) {
    this.#assertSyncEpoch(expectedSyncEpoch)
    await this.workspaces.assertOwned(accountId, workspaceId)
    const before = beforeValue === null ? null : counter(beforeValue, 'before')
    const rows = await this.database.db.select().from(objectVersions).where(and(
      eq(objectVersions.workspaceId, workspaceId),
      eq(objectVersions.objectId, objectId),
      ...(before === null ? [] : [sql`${objectVersions.revision} < ${before}`]),
    )).orderBy(sql`${objectVersions.revision} desc`).limit(limit + 1)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    return {
      versions: page.map(serializeObjectVersion),
      nextBefore: hasMore ? page.at(-1)?.revision.toString() ?? null : null,
      hasMore,
    }
  }

  async bootstrap(
    accountId: string,
    workspaceId: string,
    bootstrapId: string | null,
    afterObjectId: string | null,
    limit: number,
    expectedSyncEpoch?: string,
  ) {
    this.#assertSyncEpoch(expectedSyncEpoch)
    await this.workspaces.assertOwned(accountId, workspaceId)
    const session = await this.database.db.transaction(async (tx) => {
      await assertAccountWriteAllowedInTransaction(tx, accountId)
      await tx.delete(syncBootstrapSessions).where(sql`${syncBootstrapSessions.expiresAt} <= now()`)
      if (bootstrapId !== null) {
        const [existing] = await tx.select().from(syncBootstrapSessions).where(and(
          eq(syncBootstrapSessions.id, bootstrapId), eq(syncBootstrapSessions.workspaceId, workspaceId),
          gt(syncBootstrapSessions.expiresAt, new Date()),
        )).limit(1)
        if (existing === undefined) {
          throw new ApiError({ code: 'bootstrap_expired', message: 'Bootstrap snapshot expired; restart bootstrap', statusCode: 409, retryable: true })
        }
        return existing
      }
      const [lockedWorkspace] = await tx.select({ latestSequence: workspaces.latestSequence }).from(workspaces)
        .where(eq(workspaces.id, workspaceId)).limit(1).for('update')
      if (lockedWorkspace === undefined) throw new ApiError({ code: 'workspace_not_found', message: 'Workspace not found', statusCode: 404 })
      const [created] = await tx.insert(syncBootstrapSessions).values({
        workspaceId, snapshotSequence: lockedWorkspace.latestSequence,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      }).returning()
      if (created === undefined) throw new Error('Bootstrap session insert returned no row')
      await tx.execute(sql`
        insert into sync_bootstrap_objects(
          session_id, workspace_id, object_id, revision, document_id,
          latest_document_sequence, checkpoint_document_sequence, checkpoint_id,
          checkpoint_key_version, checkpoint_ciphertext, checkpoint_ciphertext_hash, materialized_revision
        )
        select ${created.id}, o.workspace_id, o.object_id, o.current_revision, d.document_id,
          d.latest_document_sequence, d.checkpoint_document_sequence, d.checkpoint_id,
          d.checkpoint_key_version, d.checkpoint_ciphertext, d.checkpoint_ciphertext_hash, d.materialized_revision
        from objects o
        left join sync_documents d
          on d.workspace_id = o.workspace_id and d.object_id = o.object_id
        where o.workspace_id = ${workspaceId}
      `)
      return created
    })
    const rows = await this.database.db.select({ manifest: syncBootstrapObjects, object: objectVersions })
      .from(syncBootstrapObjects).innerJoin(objectVersions, and(
        eq(objectVersions.workspaceId, syncBootstrapObjects.workspaceId),
        eq(objectVersions.objectId, syncBootstrapObjects.objectId),
        eq(objectVersions.revision, syncBootstrapObjects.revision),
      )).where(and(
        eq(syncBootstrapObjects.sessionId, session.id),
        afterObjectId === null ? sql`true` : gt(syncBootstrapObjects.objectId, afterObjectId),
      )).orderBy(asc(syncBootstrapObjects.objectId)).limit(limit + 1)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const unresolved = afterObjectId === null
      ? await this.database.db.select().from(syncConflicts).where(and(
          eq(syncConflicts.workspaceId, workspaceId),
          sql`${syncConflicts.createdSequence} <= ${session.snapshotSequence}`,
          sql`(${syncConflicts.resolvedSequence} is null or ${syncConflicts.resolvedSequence} > ${session.snapshotSequence})`,
        )).orderBy(asc(syncConflicts.createdSequence))
      : []
    return {
      bootstrapId: session.id,
      snapshotSequence: session.snapshotSequence.toString(),
      objects: page.map(({ object, manifest }) => ({
        objectId: object.objectId,
        kind: object.kind,
        parentObjectId: object.parentObjectId,
        nameCiphertext: object.nameCiphertext,
        nameBlindIndexPresent: object.nameBlindIndex !== null,
        currentRevision: object.revision.toString(),
        ciphertext: object.ciphertext,
        ciphertextHash: object.ciphertextHash,
        keyVersion: object.keyVersion,
        blobRefs: object.blobRefs,
        deletedAt: object.deleted ? object.createdAt : null,
        document: manifest.documentId === null ? null : {
          documentId: manifest.documentId,
          latestDocumentSequence: manifest.latestDocumentSequence?.toString() ?? '0',
          checkpointDocumentSequence: manifest.checkpointDocumentSequence?.toString() ?? '0',
          checkpointId: manifest.checkpointId,
          checkpointKeyVersion: manifest.checkpointKeyVersion,
          checkpointCiphertext: manifest.checkpointCiphertext,
          checkpointCiphertextHash: manifest.checkpointCiphertextHash,
          materializedRevision: manifest.materializedRevision?.toString() ?? null,
        },
      })),
      conflicts: unresolved.map(serializeConflict),
      nextObjectId: hasMore ? page.at(-1)?.manifest.objectId ?? null : null,
      hasMore,
    }
  }

  async documentUpdates(accountId: string, workspaceId: string, documentId: string, after: string, limit: number, expectedSyncEpoch?: string) {
    this.#assertSyncEpoch(expectedSyncEpoch)
    await this.workspaces.assertOwned(accountId, workspaceId)
    const cursor = counter(after, 'after')
    const rows = await this.database.db.select().from(syncUpdates).where(and(
      eq(syncUpdates.workspaceId, workspaceId), eq(syncUpdates.documentId, documentId),
      gt(syncUpdates.documentSequence, cursor),
    )).orderBy(asc(syncUpdates.documentSequence)).limit(limit + 1)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    return {
      updates: page.map(row => ({ ...row, documentSequence: row.documentSequence.toString(), eventSequence: row.eventSequence.toString() })),
      nextDocumentSequence: page.at(-1)?.documentSequence.toString() ?? after,
      hasMore,
    }
  }

  #assertSyncEpoch(expectedSyncEpoch: string | undefined): void {
    if (expectedSyncEpoch !== undefined && this.syncEpoch !== undefined && expectedSyncEpoch !== this.syncEpoch) {
      throw new ApiError({ code: 'sync_epoch_changed', message: 'Server restore epoch changed; re-bootstrap before continuing', statusCode: 409 })
    }
  }

  async #command(accountId: string, deviceId: string, workspaceId: string, command: SyncCommand): Promise<SyncCommandResult> {
    if ('ciphertext' in command) this.#validateEnvelope(command)
    const requestHash = createHash('sha256').update(JSON.stringify(command)).digest('base64url')
    const storageLimit = this.storageLimitResolver === undefined ? null : await this.storageLimitResolver(accountId)
    const result = await this.database.db.transaction(async (tx) => {
      await assertAccountWriteAllowedInTransaction(tx, accountId)
      const [lockedWorkspace] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(
        eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId), isNull(workspaces.deletedAt),
      )).limit(1).for('update')
      if (lockedWorkspace === undefined) throw new ApiError({ code: 'workspace_not_found', message: 'Workspace not found', statusCode: 404 })
      const [previous] = await tx.select().from(syncCommands).where(and(
        eq(syncCommands.workspaceId, workspaceId), eq(syncCommands.commandId, command.commandId),
      )).limit(1)
      if (previous !== undefined) {
        if (previous.requestHash !== requestHash) throw new ApiError({ code: 'command_id_reused', message: 'Command ID was reused', statusCode: 409 })
        return { ...(previous.result as SyncCommandResult), duplicate: true }
      }

      const applied = await this.#apply(tx, accountId, deviceId, workspaceId, command, storageLimit)
      await tx.insert(syncCommands).values({
        workspaceId, commandId: command.commandId, sourceDeviceId: deviceId, requestHash,
        result: applied as unknown as Record<string, unknown>,
      })
      return applied
    })
    if ((result.status === 'applied' || result.status === 'conflict') && result.sequence !== undefined) {
      await this.notifier.publish({ type: 'workspace.changed', workspaceId, latestSequence: result.sequence }).catch(() => undefined)
    }
    return result
  }

  async #apply(tx: SyncTransaction, accountId: string, deviceId: string, workspaceId: string, command: SyncCommand, storageLimit: bigint | null): Promise<SyncCommandResult> {
    if (command.type === 'upsert-object' || command.type === 'delete-object') {
      const [current] = await tx.select().from(objects).where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectId, command.objectId))).limit(1)
      if (current !== undefined && current.kind !== command.kind) {
        throw new ApiError({ code: 'object_kind_mismatch', message: 'An object cannot change its sync kind', statusCode: 409 })
      }
      const expected = command.baseRevision === null ? null : counter(command.baseRevision, 'baseRevision')
      const actual = current?.currentRevision ?? null
      if (expected !== actual) return {
        commandId: command.commandId, status: 'conflict', duplicate: false, code: 'revision_conflict',
        ...(actual === null ? {} : { revision: actual.toString() }),
      }
      const parentObjectId = command.parentObjectId === undefined
        ? current?.parentObjectId ?? null : command.parentObjectId
      const nameCiphertext = command.nameCiphertext === undefined
        ? current?.nameCiphertext ?? null : command.nameCiphertext
      const nameBlindIndex = command.type === 'upsert-object' && command.nameBlindIndex !== undefined
        ? command.nameBlindIndex : current?.nameBlindIndex ?? null
      if (command.type === 'upsert-object' && nameBlindIndex !== null) {
        const [oldestKey] = await tx.select({ keyVersion: workspaceKeys.keyVersion }).from(workspaceKeys)
          .where(eq(workspaceKeys.workspaceId, workspaceId)).orderBy(asc(workspaceKeys.keyVersion)).limit(1)
        if (oldestKey === undefined || command.nameBlindIndexKeyVersion !== oldestKey.keyVersion) {
          throw new ApiError({ code: 'name_blind_index_key_mismatch',
            message: 'Name blind indexes must use the oldest retained workspace key', statusCode: 409 })
        }
      }
      if (command.type === 'upsert-object') await this.#assertValidParent(tx, workspaceId, command.objectId, parentObjectId)
      const resourceObjectIds = command.type === 'upsert-object'
        ? Array.from(new Set(command.resourceObjectIds ?? [])) : []
      if (command.kind === 'asset' && resourceObjectIds.length > 0) {
        throw new ApiError({ code: 'asset_cannot_bind_resources', message: 'Asset objects cannot bind other resources', statusCode: 409 })
      }
      const resourceRevisions = new Map<string, bigint>()
      if (resourceObjectIds.length > 0) {
        const resources = await tx.select({
          objectId: objects.objectId, kind: objects.kind,
          revision: objects.currentRevision, deletedAt: objects.deletedAt,
        }).from(objects).where(and(
          eq(objects.workspaceId, workspaceId), inArray(objects.objectId, resourceObjectIds),
        ))
        for (const resource of resources) {
          if (resource.kind !== 'asset' || resource.deletedAt !== null) continue
          resourceRevisions.set(resource.objectId, resource.revision)
        }
        if (resourceRevisions.size !== resourceObjectIds.length) {
          throw new ApiError({
            code: 'resource_not_ready',
            message: 'Every bound resource must be a ready asset object in the same workspace',
            statusCode: 409,
          })
        }
      }
      if (command.type === 'delete-object') {
        if (command.kind === 'asset') {
          const bindings = await tx.select({
            ownerObjectId: syncResourceBindings.ownerObjectId,
            ownerRevision: syncResourceBindings.ownerRevision,
          }).from(syncResourceBindings).where(and(
            eq(syncResourceBindings.workspaceId, workspaceId),
            eq(syncResourceBindings.resourceObjectId, command.objectId),
          ))
          if (bindings.length > 0) {
            const ownerIds = Array.from(new Set(bindings.map(binding => binding.ownerObjectId)))
            const owners = await tx.select({
              objectId: objects.objectId,
              revision: objects.currentRevision,
              deletedAt: objects.deletedAt,
            }).from(objects).where(and(
              eq(objects.workspaceId, workspaceId), inArray(objects.objectId, ownerIds),
            ))
            const currentOwners = new Map(owners.map(owner => [owner.objectId, owner]))
            const stillReferenced = bindings.some(binding => {
              const owner = currentOwners.get(binding.ownerObjectId)
              return owner?.deletedAt === null && owner.revision === binding.ownerRevision
            })
            if (stillReferenced) {
              throw new ApiError({
                code: 'resource_still_referenced',
                message: 'An asset cannot be deleted while a current object references it',
                statusCode: 409,
                retryable: true,
              })
            }
          }
        }
        const [document] = await tx.select().from(syncDocuments).where(and(
          eq(syncDocuments.workspaceId, workspaceId), eq(syncDocuments.objectId, command.objectId),
        )).limit(1)
        const seen = counter(command.expectedDocumentSequence, 'expectedDocumentSequence')
        if ((document?.latestDocumentSequence ?? 0n) > seen) {
          this.#validateCiphertext(command.conflictCiphertext, command.conflictCiphertextHash)
          const [existingConflict] = await tx.select().from(syncConflicts).where(and(
            eq(syncConflicts.workspaceId, workspaceId),
            eq(syncConflicts.conflictId, command.conflictId),
          )).limit(1)
          if (existingConflict !== undefined) {
            if (existingConflict.objectId !== command.objectId
              || existingConflict.kind !== command.kind
              || existingConflict.type !== 'delete-vs-edit') {
              throw new ApiError({
                code: 'conflict_id_reused',
                message: 'Conflict ID is already bound to another conflict',
                statusCode: 409,
              })
            }
            return {
              commandId: command.commandId,
              status: 'conflict', duplicate: false, code: 'delete_edit_conflict',
              conflictId: command.conflictId,
              sequence: existingConflict.createdSequence.toString(),
            }
          }
          const sequence = await nextSequence(tx, workspaceId)
          await tx.insert(syncConflicts).values({
            workspaceId, conflictId: command.conflictId, objectId: command.objectId, kind: command.kind,
            type: 'delete-vs-edit', expectedRevision: expected, expectedDocumentSequence: seen,
            keyVersion: command.keyVersion, ciphertext: command.conflictCiphertext,
            ciphertextHash: command.conflictCiphertextHash, createdSequence: sequence,
          }).onConflictDoNothing()
          await insertEvent(tx, {
            workspaceId, sequence, commandId: command.commandId, deviceId, type: 'conflict.created',
            objectId: command.objectId, keyVersion: command.keyVersion,
            ciphertext: command.conflictCiphertext, ciphertextHash: command.conflictCiphertextHash,
            metadata: { conflictId: command.conflictId, conflictType: 'delete-vs-edit', kind: command.kind },
          })
          return { commandId: command.commandId, status: 'conflict', duplicate: false, code: 'delete_edit_conflict', conflictId: command.conflictId, sequence: sequence.toString() }
        }
      }
      await this.#assertKeyAndBlobs(tx, workspaceId, command.keyVersion, command.blobRefs)
      const revision = (actual ?? 0n) + 1n
      const sequence = await nextSequence(tx, workspaceId)
      const deleted = command.type === 'delete-object'
      const nameCollision = command.type === 'upsert-object' && nameBlindIndex !== null
        ? await tx.select({ objectId: objects.objectId }).from(objects).where(and(
            eq(objects.workspaceId, workspaceId), ne(objects.objectId, command.objectId),
            parentObjectId === null ? isNull(objects.parentObjectId) : eq(objects.parentObjectId, parentObjectId),
            eq(objects.nameBlindIndex, nameBlindIndex), isNull(objects.deletedAt),
          )).limit(1).then(rows => rows[0])
        : undefined
      const existingSameNameConflict = nameCollision === undefined ? undefined
        : await tx.select({ conflictId: syncConflicts.conflictId }).from(syncConflicts).where(and(
            eq(syncConflicts.workspaceId, workspaceId), eq(syncConflicts.objectId, command.objectId),
            eq(syncConflicts.type, 'same-name'), eq(syncConflicts.status, 'unresolved'),
          )).limit(1).then(rows => rows[0])
      const nameConflict = command.type === 'upsert-object' ? {
        id: command.nameConflictId,
        ciphertext: command.nameConflictCiphertext,
        ciphertextHash: command.nameConflictCiphertextHash,
      } : null
      if (nameCollision !== undefined && existingSameNameConflict === undefined
        && (!nameConflict?.id || !nameConflict.ciphertext
        || !nameConflict.ciphertextHash)) {
        throw new ApiError({
          code: 'same_name_conflict_envelope_required',
          message: 'A sibling with the same encrypted name index exists; an encrypted conflict envelope is required',
          statusCode: 409,
        })
      }
      if (nameCollision !== undefined && existingSameNameConflict === undefined) {
        this.#validateCiphertext(nameConflict!.ciphertext!, nameConflict!.ciphertextHash!)
      }
      await this.usage?.applyCurrentObject(tx, {
        accountId,
        previousBytes: current === undefined ? 0n : BigInt(Buffer.from(current.ciphertext, 'base64url').byteLength),
        previousActive: current !== undefined && current.deletedAt === null,
        nextBytes: BigInt(Buffer.from(command.ciphertext, 'base64url').byteLength),
        nextActive: !deleted,
        storageLimit,
      })
      await tx.insert(objectVersions).values({
        workspaceId, objectId: command.objectId, revision, sequence, kind: command.kind,
        parentObjectId,
        nameCiphertext,
        nameBlindIndex,
        ciphertext: command.ciphertext, ciphertextHash: command.ciphertextHash, keyVersion: command.keyVersion,
        blobRefs: command.blobRefs, sourceDeviceId: deviceId, deleted,
      })
      await tx.insert(objects).values({
        workspaceId, objectId: command.objectId, kind: command.kind, currentRevision: revision,
        parentObjectId,
        nameCiphertext,
        nameBlindIndex,
        ciphertext: command.ciphertext, ciphertextHash: command.ciphertextHash, keyVersion: command.keyVersion,
        blobRefs: command.blobRefs, deletedAt: deleted ? new Date() : null,
      }).onConflictDoUpdate({
        target: [objects.workspaceId, objects.objectId],
        set: { kind: command.kind, currentRevision: revision, ciphertext: command.ciphertext,
          parentObjectId,
          nameCiphertext,
          nameBlindIndex,
          ciphertextHash: command.ciphertextHash, keyVersion: command.keyVersion, blobRefs: command.blobRefs,
          deletedAt: deleted ? new Date() : null, updatedAt: new Date() },
      })
      if (!deleted && resourceRevisions.size > 0) {
        await tx.insert(syncResourceBindings).values(Array.from(resourceRevisions, ([resourceObjectId, resourceRevision]) => ({
          workspaceId,
          ownerObjectId: command.objectId,
          ownerRevision: revision,
          resourceObjectId,
          resourceRevision,
        })))
      }
      await insertEvent(tx, {
        workspaceId, sequence, commandId: command.commandId, deviceId,
        type: deleted ? 'object.deleted' : 'object.upserted', objectId: command.objectId,
        keyVersion: command.keyVersion, ciphertext: command.ciphertext, ciphertextHash: command.ciphertextHash,
        metadata: { kind: command.kind, revision: revision.toString(), blobRefs: command.blobRefs,
          parentObjectId },
      })
      if (existingSameNameConflict !== undefined) {
        return { commandId: command.commandId, status: 'applied', duplicate: false,
          revision: revision.toString(), sequence: sequence.toString(),
          conflictId: existingSameNameConflict.conflictId }
      }
      if (nameCollision !== undefined) {
        const conflictSequence = await nextSequence(tx, workspaceId)
        await tx.insert(syncConflicts).values({
          workspaceId, conflictId: nameConflict!.id!, objectId: command.objectId, kind: command.kind,
          type: 'same-name', expectedRevision: revision, expectedDocumentSequence: null,
          keyVersion: command.keyVersion, ciphertext: nameConflict!.ciphertext!,
          ciphertextHash: nameConflict!.ciphertextHash!, createdSequence: conflictSequence,
        })
        await insertEvent(tx, {
          workspaceId, sequence: conflictSequence, commandId: command.commandId, deviceId,
          type: 'conflict.created', objectId: command.objectId, keyVersion: command.keyVersion,
          ciphertext: nameConflict!.ciphertext!, ciphertextHash: nameConflict!.ciphertextHash!,
          metadata: { conflictId: nameConflict!.id, conflictType: 'same-name', kind: command.kind,
            conflictingObjectId: nameCollision.objectId, parentObjectId },
        })
        return { commandId: command.commandId, status: 'applied', duplicate: false,
          revision: revision.toString(), sequence: conflictSequence.toString(), conflictId: nameConflict!.id! }
      }
      return { commandId: command.commandId, status: 'applied', duplicate: false, revision: revision.toString(), sequence: sequence.toString() }
    }

    if (command.type === 'delete-subtree') {
      this.#validateCiphertext(command.conflictCiphertext, command.conflictCiphertextHash)
      await this.#assertKeyAndBlobs(tx, workspaceId, command.conflictKeyVersion, [])
      const currentObjects = await tx.select().from(objects).where(eq(objects.workspaceId, workspaceId))
      const root = currentObjects.find(object => object.objectId === command.rootObjectId)
      if (root === undefined || root.kind !== 'folder') {
        throw new ApiError({ code: 'subtree_root_invalid', message: 'Subtree root must be an active folder', statusCode: 409 })
      }
      if (root.deletedAt !== null) {
        const descendants = new Set<string>([root.objectId])
        let changed = true
        while (changed) {
          changed = false
          for (const object of currentObjects) {
            if (object.parentObjectId !== null && descendants.has(object.parentObjectId)
              && !descendants.has(object.objectId)) {
              descendants.add(object.objectId)
              changed = true
            }
          }
        }
        const activeDescendant = currentObjects.some(object => (
          object.objectId !== root.objectId && descendants.has(object.objectId) && object.deletedAt === null
        ))
        if (activeDescendant) {
          throw new ApiError({
            code: 'subtree_root_deleted_with_active_descendants',
            message: 'Deleted subtree root still has active descendants',
            statusCode: 409,
          })
        }
        return { commandId: command.commandId, status: 'applied', duplicate: true }
      }
      const descendants = new Set<string>([root.objectId])
      let changed = true
      while (changed) {
        changed = false
        for (const object of currentObjects) {
          if (object.deletedAt === null && object.parentObjectId !== null
            && descendants.has(object.parentObjectId) && !descendants.has(object.objectId)) {
            descendants.add(object.objectId)
            changed = true
          }
        }
      }
      const requestedIds = new Set(command.objects.map(object => object.objectId))
      if (requestedIds.size !== command.objects.length || requestedIds.size !== descendants.size
        || [...descendants].some(objectId => !requestedIds.has(objectId))) {
        throw new ApiError({
          code: 'subtree_changed', message: 'Folder subtree changed; refresh before deleting', statusCode: 409,
          details: { expectedObjectCount: descendants.size },
        })
      }
      const requested = new Map(command.objects.map(object => [object.objectId, object]))
      const documentRows = await tx.select().from(syncDocuments).where(eq(syncDocuments.workspaceId, workspaceId))
      let editConflict = false
      for (const current of currentObjects.filter(object => descendants.has(object.objectId))) {
        const item = requested.get(current.objectId)
        if (item === undefined || item.kind !== current.kind
          || counter(item.baseRevision, 'baseRevision') !== current.currentRevision) {
          throw new ApiError({ code: 'subtree_changed', message: 'Folder subtree revision changed; refresh before deleting', statusCode: 409 })
        }
        this.#validateEnvelope(item)
        await this.#assertKeyAndBlobs(tx, workspaceId, item.keyVersion, item.blobRefs)
        const document = documentRows.find(row => row.objectId === current.objectId)
        if ((document?.latestDocumentSequence ?? 0n) > counter(item.expectedDocumentSequence, 'expectedDocumentSequence')) {
          editConflict = true
        }
      }
      if (editConflict) {
        const sequence = await nextSequence(tx, workspaceId)
        await tx.insert(syncConflicts).values({
          workspaceId, conflictId: command.conflictId, objectId: root.objectId, kind: root.kind,
          type: 'delete-subtree-vs-edit', expectedRevision: root.currentRevision,
          expectedDocumentSequence: null, keyVersion: command.conflictKeyVersion,
          ciphertext: command.conflictCiphertext, ciphertextHash: command.conflictCiphertextHash,
          createdSequence: sequence,
        })
        await insertEvent(tx, {
          workspaceId, sequence, commandId: command.commandId, deviceId, type: 'conflict.created',
          objectId: root.objectId, keyVersion: command.conflictKeyVersion,
          ciphertext: command.conflictCiphertext, ciphertextHash: command.conflictCiphertextHash,
          metadata: { conflictId: command.conflictId, conflictType: 'delete-subtree-vs-edit', kind: root.kind },
        })
        return { commandId: command.commandId, status: 'conflict', duplicate: false,
          code: 'delete_edit_conflict', conflictId: command.conflictId, sequence: sequence.toString() }
      }
      const depth = (object: typeof objects.$inferSelect): number => {
        let value = 0
        let parentId = object.parentObjectId
        const seen = new Set<string>()
        while (parentId !== null && descendants.has(parentId) && !seen.has(parentId)) {
          seen.add(parentId)
          value += 1
          parentId = currentObjects.find(candidate => candidate.objectId === parentId)?.parentObjectId ?? null
        }
        return value
      }
      let finalSequence = 0n
      for (const current of currentObjects.filter(object => descendants.has(object.objectId)).sort((a, b) => depth(b) - depth(a))) {
        const item = requested.get(current.objectId)
        if (item === undefined) throw new Error('Validated subtree item disappeared')
        const revision = current.currentRevision + 1n
        finalSequence = await nextSequence(tx, workspaceId)
        await this.usage?.applyCurrentObject(tx, {
          accountId,
          previousBytes: BigInt(Buffer.from(current.ciphertext, 'base64url').byteLength), previousActive: current.deletedAt === null,
          nextBytes: 0n, nextActive: false, storageLimit,
        })
        await tx.insert(objectVersions).values({
          workspaceId, objectId: current.objectId, revision, sequence: finalSequence, kind: current.kind,
          parentObjectId: current.parentObjectId, nameCiphertext: current.nameCiphertext,
          nameBlindIndex: current.nameBlindIndex,
          ciphertext: item.ciphertext, ciphertextHash: item.ciphertextHash, keyVersion: item.keyVersion,
          blobRefs: item.blobRefs, sourceDeviceId: deviceId, deleted: true,
        })
        await tx.update(objects).set({
          currentRevision: revision, ciphertext: item.ciphertext, ciphertextHash: item.ciphertextHash,
          keyVersion: item.keyVersion, blobRefs: item.blobRefs, deletedAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectId, current.objectId)))
        await insertEvent(tx, {
          workspaceId, sequence: finalSequence, commandId: command.commandId, deviceId,
          type: 'object.deleted', objectId: current.objectId, keyVersion: item.keyVersion,
          ciphertext: item.ciphertext, ciphertextHash: item.ciphertextHash,
          metadata: { kind: current.kind, revision: revision.toString(), blobRefs: item.blobRefs,
            parentObjectId: current.parentObjectId, subtreeRootObjectId: root.objectId },
        })
      }
      return { commandId: command.commandId, status: 'applied', duplicate: false, sequence: finalSequence.toString() }
    }

    if (command.type === 'append-update') {
      await this.#assertKeyAndBlobs(tx, workspaceId, command.keyVersion, [])
      const [currentObject] = await tx.select({ deletedAt: objects.deletedAt, kind: objects.kind }).from(objects).where(and(
        eq(objects.workspaceId, workspaceId), eq(objects.objectId, command.objectId),
      )).limit(1)
      if (currentObject === undefined || currentObject.deletedAt !== null) throw new ApiError({ code: 'document_object_inactive', message: 'Document object is missing or deleted', statusCode: 409 })
      if (currentObject.kind !== command.kind) throw new ApiError({ code: 'object_kind_mismatch', message: 'Document kind does not match its object', statusCode: 409 })
      const [duplicate] = await tx.select().from(syncUpdates).where(and(
        eq(syncUpdates.workspaceId, workspaceId), eq(syncUpdates.updateId, command.updateId),
      )).limit(1)
      if (duplicate !== undefined) {
        if (duplicate.documentId !== command.documentId || duplicate.keyVersion !== command.keyVersion
          || duplicate.ciphertextHash !== command.ciphertextHash) {
          throw new ApiError({ code: 'update_id_reused', message: 'Update ID was reused with different content', statusCode: 409 })
        }
        return { commandId: command.commandId, status: 'applied', duplicate: true, sequence: duplicate.eventSequence.toString(), documentSequence: duplicate.documentSequence.toString() }
      }
      const [document] = await tx.select().from(syncDocuments).where(and(
        eq(syncDocuments.workspaceId, workspaceId), eq(syncDocuments.documentId, command.documentId),
      )).limit(1).for('update')
      if (document !== undefined && (document.objectId !== command.objectId || document.kind !== command.kind)) {
        throw new ApiError({ code: 'document_identity_mismatch', message: 'Document ID is already bound to another object', statusCode: 409 })
      }
      const documentSequence = (document?.latestDocumentSequence ?? 0n) + 1n
      const sequence = await nextSequence(tx, workspaceId)
      await tx.insert(syncDocuments).values({
        workspaceId, documentId: command.documentId, objectId: command.objectId, kind: command.kind,
        latestDocumentSequence: documentSequence,
      }).onConflictDoUpdate({
        target: [syncDocuments.workspaceId, syncDocuments.documentId],
        set: { latestDocumentSequence: documentSequence, updatedAt: new Date() },
      })
      await tx.insert(syncUpdates).values({
        workspaceId, documentId: command.documentId, documentSequence, updateId: command.updateId,
        eventSequence: sequence, sourceDeviceId: deviceId, keyVersion: command.keyVersion,
        ciphertext: command.ciphertext, ciphertextHash: command.ciphertextHash,
      })
      await this.usage?.applyActiveCrdtDelta(tx, accountId, BigInt(Buffer.from(command.ciphertext, 'base64url').byteLength), storageLimit)
      await insertEvent(tx, {
        workspaceId, sequence, commandId: command.commandId, deviceId, type: 'document.updated',
        objectId: command.objectId, documentId: command.documentId, documentSequence,
        keyVersion: command.keyVersion, ciphertext: command.ciphertext, ciphertextHash: command.ciphertextHash,
        metadata: { updateId: command.updateId, kind: command.kind },
      })
      return { commandId: command.commandId, status: 'applied', duplicate: false, sequence: sequence.toString(), documentSequence: documentSequence.toString() }
    }

    if (command.type === 'commit-checkpoint') {
      await this.#assertKeyAndBlobs(tx, workspaceId, command.keyVersion, [])
      const covers = counter(command.coversDocumentSequence, 'coversDocumentSequence')
      const [document] = await tx.select().from(syncDocuments).where(and(
        eq(syncDocuments.workspaceId, workspaceId), eq(syncDocuments.documentId, command.documentId),
      )).limit(1).for('update')
      if (document === undefined || document.objectId !== command.objectId || document.kind !== command.kind) {
        throw new ApiError({ code: 'document_not_found', message: 'Document not found or identity does not match', statusCode: 404 })
      }
      if (covers !== document.latestDocumentSequence || covers <= document.checkpointDocumentSequence) {
        throw new ApiError({
          code: 'checkpoint_not_current',
          message: 'Checkpoint must advance through the current contiguous document sequence',
          statusCode: 409,
          retryable: true,
          details: {
            latestDocumentSequence: document.latestDocumentSequence.toString(),
            checkpointDocumentSequence: document.checkpointDocumentSequence.toString(),
          },
        })
      }
      const sequence = await nextSequence(tx, workspaceId)
      const materializedRevision = command.materializedRevision === null ? null : counter(command.materializedRevision, 'materializedRevision')
      await tx.insert(syncCheckpoints).values({
        workspaceId, checkpointId: command.checkpointId, documentId: command.documentId,
        objectId: command.objectId, coversDocumentSequence: covers, eventSequence: sequence,
        materializedRevision, keyVersion: command.keyVersion, ciphertext: command.ciphertext,
        ciphertextHash: command.ciphertextHash, sourceDeviceId: deviceId,
      })
      await tx.update(syncDocuments).set({
        checkpointDocumentSequence: covers, checkpointId: command.checkpointId,
        checkpointKeyVersion: command.keyVersion, checkpointCiphertext: command.ciphertext,
        checkpointCiphertextHash: command.ciphertextHash, materializedRevision, updatedAt: new Date(),
      }).where(and(eq(syncDocuments.workspaceId, workspaceId), eq(syncDocuments.documentId, command.documentId)))
      const prunedBytes = await this.#pruneCoveredUpdates(tx, workspaceId, command.documentId, covers)
      await this.usage?.applyActiveCrdtDelta(tx, accountId,
        BigInt(Buffer.from(command.ciphertext, 'base64url').byteLength)
          - BigInt(document.checkpointCiphertext === null ? 0 : Buffer.from(document.checkpointCiphertext, 'base64url').byteLength)
          - prunedBytes,
        storageLimit)
      await insertEvent(tx, {
        workspaceId, sequence, commandId: command.commandId, deviceId, type: 'document.checkpointed',
        objectId: command.objectId, documentId: command.documentId, documentSequence: covers,
        keyVersion: command.keyVersion, ciphertext: command.ciphertext, ciphertextHash: command.ciphertextHash,
        metadata: { checkpointId: command.checkpointId, materializedRevision: command.materializedRevision },
      })
      return { commandId: command.commandId, status: 'applied', duplicate: false, sequence: sequence.toString(), documentSequence: covers.toString() }
    }

    if (command.type === 'create-conflict') {
      await this.#assertKeyAndBlobs(tx, workspaceId, command.keyVersion, [])
      const expectedRevision = command.expectedRevision === null ? null : counter(command.expectedRevision, 'expectedRevision')
      const expectedDocumentSequence = command.expectedDocumentSequence === null
        ? null : counter(command.expectedDocumentSequence, 'expectedDocumentSequence')
      const [existingConflict] = await tx.select().from(syncConflicts).where(and(
        eq(syncConflicts.workspaceId, workspaceId), eq(syncConflicts.conflictId, command.conflictId),
      )).limit(1)
      if (existingConflict !== undefined) {
        if (existingConflict.objectId !== command.objectId
          || existingConflict.kind !== command.kind
          || existingConflict.type !== command.conflictType
          || existingConflict.expectedRevision !== expectedRevision
          || existingConflict.expectedDocumentSequence !== expectedDocumentSequence) {
          throw new ApiError({
            code: 'conflict_id_reused',
            message: 'Conflict ID is already bound to another conflict',
            statusCode: 409,
          })
        }
        return {
          commandId: command.commandId,
          status: 'applied',
          duplicate: true,
          sequence: existingConflict.createdSequence.toString(),
          conflictId: existingConflict.conflictId,
        }
      }
      const [object] = await tx.select().from(objects).where(and(
        eq(objects.workspaceId, workspaceId), eq(objects.objectId, command.objectId),
      )).limit(1)
      if (object === undefined || object.kind !== command.kind) {
        throw new ApiError({ code: 'conflict_object_not_found', message: 'Conflict object is missing or has another kind', statusCode: 409 })
      }
      const [document] = await tx.select().from(syncDocuments).where(and(
        eq(syncDocuments.workspaceId, workspaceId), eq(syncDocuments.objectId, command.objectId),
      )).limit(1)
      if ((expectedRevision !== null && object.currentRevision !== expectedRevision)
        || (expectedDocumentSequence !== null && (document?.latestDocumentSequence ?? 0n) !== expectedDocumentSequence)) {
        return { commandId: command.commandId, status: 'conflict', duplicate: false, code: 'conflict_changed' }
      }
      const sequence = await nextSequence(tx, workspaceId)
      await tx.insert(syncConflicts).values({
        workspaceId, conflictId: command.conflictId, objectId: command.objectId, kind: command.kind,
        type: command.conflictType,
        expectedRevision,
        expectedDocumentSequence,
        keyVersion: command.keyVersion, ciphertext: command.ciphertext,
        ciphertextHash: command.ciphertextHash, createdSequence: sequence,
      })
      await insertEvent(tx, {
        workspaceId, sequence, commandId: command.commandId, deviceId, type: 'conflict.created',
        objectId: command.objectId, keyVersion: command.keyVersion, ciphertext: command.ciphertext,
        ciphertextHash: command.ciphertextHash,
        metadata: { conflictId: command.conflictId, conflictType: command.conflictType, kind: command.kind },
      })
      return { commandId: command.commandId, status: 'applied', duplicate: false, sequence: sequence.toString(), conflictId: command.conflictId }
    }

    if (command.deleteObject === true && (command.objectResolution !== undefined || command.resolution !== undefined)) {
      throw new ApiError({ code: 'request_invalid', message: 'Delete conflict resolution cannot also restore content', statusCode: 400 })
    }
    if (command.requiresCommandId !== undefined) {
      const [required] = await tx.select({ result: syncCommands.result }).from(syncCommands).where(and(
        eq(syncCommands.workspaceId, workspaceId), eq(syncCommands.commandId, command.requiresCommandId),
      )).limit(1)
      if (required === undefined || required.result.status !== 'applied') {
        throw new ApiError({
          code: 'required_command_not_applied', message: 'Required command was not applied',
          statusCode: 409,
        })
      }
    }
    const [conflict] = await tx.select().from(syncConflicts).where(and(
      eq(syncConflicts.workspaceId, workspaceId), eq(syncConflicts.conflictId, command.conflictId),
    )).limit(1).for('update')
    if (conflict === undefined) throw new ApiError({ code: 'conflict_not_found', message: 'Conflict not found', statusCode: 404 })
    const expectedCreatedSequence = counter(command.expectedCreatedSequence, 'expectedCreatedSequence')
    if (conflict.createdSequence !== expectedCreatedSequence) {
      // Older servers emitted another conflict.created event whenever the same
      // conflict envelope was retried with a fresh command ID. Those duplicate
      // event sequences are valid aliases for the conflict's original sequence.
      const [duplicateEvent] = await tx.select({ sequence: syncEvents.sequence }).from(syncEvents).where(and(
        eq(syncEvents.workspaceId, workspaceId),
        eq(syncEvents.sequence, expectedCreatedSequence),
        eq(syncEvents.type, 'conflict.created'),
        eq(syncEvents.objectId, conflict.objectId),
        sql`${syncEvents.metadata}->>'conflictId' = ${conflict.conflictId}`,
      )).limit(1)
      if (duplicateEvent === undefined) {
        return { commandId: command.commandId, status: 'conflict', duplicate: false, code: 'conflict_changed' }
      }
    }
    if (conflict.status === 'resolved') {
      return {
        commandId: command.commandId, status: 'applied', duplicate: true,
        ...(conflict.resolvedSequence === null ? {} : { sequence: conflict.resolvedSequence.toString() }),
        conflictId: conflict.conflictId,
      }
    }
    let resolutionDocument: typeof syncDocuments.$inferSelect | undefined
    if (command.resolution !== undefined) {
      this.#validateEnvelope(command.resolution)
      await this.#assertKeyAndBlobs(tx, workspaceId, command.resolution.keyVersion, [])
      if (command.resolution.objectId !== conflict.objectId || command.resolution.kind !== conflict.kind) {
        throw new ApiError({ code: 'conflict_resolution_object_mismatch', message: 'Conflict resolution targets another object', statusCode: 409 })
      }
      const [document] = await tx.select().from(syncDocuments).where(and(
        eq(syncDocuments.workspaceId, workspaceId), eq(syncDocuments.documentId, command.resolution.documentId),
      )).limit(1).for('update')
      if (document === undefined || document.objectId !== conflict.objectId) {
        throw new ApiError({ code: 'document_not_found', message: 'Conflict document not found', statusCode: 404 })
      }
      if (document.latestDocumentSequence !== counter(
        command.resolution.expectedDocumentSequence, 'expectedDocumentSequence',
      )) {
        return { commandId: command.commandId, status: 'conflict', duplicate: false, code: 'conflict_changed' }
      }
      resolutionDocument = document
    }
    let resolvedRevision = conflict.expectedRevision
    if (command.objectResolution !== undefined) {
      this.#validateEnvelope(command.objectResolution)
      const [object] = await tx.select().from(objects).where(and(
        eq(objects.workspaceId, workspaceId), eq(objects.objectId, conflict.objectId),
      )).limit(1).for('update')
      if (object === undefined || object.currentRevision === null || object.currentRevision !== conflict.expectedRevision
        || command.objectResolution.objectId !== conflict.objectId
        || command.objectResolution.kind !== conflict.kind) {
        return { commandId: command.commandId, status: 'conflict', duplicate: false, code: 'conflict_changed' }
      }
      const resolvedBlobRefs = command.objectResolution.blobRefs ?? object.blobRefs
      await this.#assertKeyAndBlobs(tx, workspaceId, command.objectResolution.keyVersion, resolvedBlobRefs)
      let resolvedResourceObjectIds = command.objectResolution.resourceObjectIds
      if (resolvedResourceObjectIds === undefined) {
        resolvedResourceObjectIds = (await tx.select({
          resourceObjectId: syncResourceBindings.resourceObjectId,
        }).from(syncResourceBindings).where(and(
          eq(syncResourceBindings.workspaceId, workspaceId),
          eq(syncResourceBindings.ownerObjectId, object.objectId),
          eq(syncResourceBindings.ownerRevision, object.currentRevision),
        ))).map(binding => binding.resourceObjectId)
      }
      resolvedResourceObjectIds = Array.from(new Set(resolvedResourceObjectIds))
      if (object.kind === 'asset' && resolvedResourceObjectIds.length > 0) {
        throw new ApiError({ code: 'asset_cannot_bind_resources', message: 'Asset objects cannot bind other resources', statusCode: 409 })
      }
      const resolvedResourceRevisions = new Map<string, bigint>()
      if (resolvedResourceObjectIds.length > 0) {
        const resources = await tx.select({
          objectId: objects.objectId, kind: objects.kind,
          revision: objects.currentRevision, deletedAt: objects.deletedAt,
        }).from(objects).where(and(
          eq(objects.workspaceId, workspaceId), inArray(objects.objectId, resolvedResourceObjectIds),
        ))
        for (const resource of resources) {
          if (resource.kind === 'asset' && resource.deletedAt === null) {
            resolvedResourceRevisions.set(resource.objectId, resource.revision)
          }
        }
        if (resolvedResourceRevisions.size !== resolvedResourceObjectIds.length) {
          throw new ApiError({ code: 'resource_not_ready', message: 'Conflict resolution references a missing asset', statusCode: 409 })
        }
      }
      const resolvedParentObjectId = command.objectResolution.parentObjectId === undefined
        ? object.parentObjectId : command.objectResolution.parentObjectId
      const resolvedNameCiphertext = command.objectResolution.nameCiphertext === undefined
        ? object.nameCiphertext : command.objectResolution.nameCiphertext
      const resolvedNameBlindIndex = command.objectResolution.nameBlindIndex === undefined
        ? object.nameBlindIndex : command.objectResolution.nameBlindIndex
      if (resolvedNameBlindIndex !== null && command.objectResolution.nameBlindIndex !== undefined) {
        const [oldestKey] = await tx.select({ keyVersion: workspaceKeys.keyVersion }).from(workspaceKeys)
          .where(eq(workspaceKeys.workspaceId, workspaceId)).orderBy(asc(workspaceKeys.keyVersion)).limit(1)
        if (oldestKey === undefined
          || command.objectResolution.nameBlindIndexKeyVersion !== oldestKey.keyVersion) {
          throw new ApiError({ code: 'name_blind_index_key_mismatch',
            message: 'Name blind indexes must use the oldest retained workspace key', statusCode: 409 })
        }
      }
      await this.#assertValidParent(tx, workspaceId, object.objectId, resolvedParentObjectId)
      if (resolvedNameBlindIndex !== null) {
        const [collision] = await tx.select({ objectId: objects.objectId }).from(objects).where(and(
          eq(objects.workspaceId, workspaceId), ne(objects.objectId, object.objectId),
          resolvedParentObjectId === null
            ? isNull(objects.parentObjectId) : eq(objects.parentObjectId, resolvedParentObjectId),
          eq(objects.nameBlindIndex, resolvedNameBlindIndex), isNull(objects.deletedAt),
        )).limit(1)
        if (collision !== undefined) {
          return { commandId: command.commandId, status: 'conflict', duplicate: false,
            code: 'same_name_still_conflicts', conflictId: conflict.conflictId }
        }
      }
      resolvedRevision = object.currentRevision + 1n
      const objectSequence = await nextSequence(tx, workspaceId)
      await this.usage?.applyCurrentObject(tx, {
        accountId,
        previousBytes: BigInt(Buffer.from(object.ciphertext, 'base64url').byteLength), previousActive: object.deletedAt === null,
        nextBytes: BigInt(Buffer.from(command.objectResolution.ciphertext, 'base64url').byteLength), nextActive: true,
        storageLimit,
      })
      await tx.insert(objectVersions).values({
        workspaceId, objectId: object.objectId, revision: resolvedRevision, sequence: objectSequence,
        kind: object.kind, parentObjectId: resolvedParentObjectId,
        nameCiphertext: resolvedNameCiphertext,
        nameBlindIndex: resolvedNameBlindIndex,
        ciphertext: command.objectResolution.ciphertext,
        ciphertextHash: command.objectResolution.ciphertextHash, keyVersion: command.objectResolution.keyVersion,
        blobRefs: resolvedBlobRefs, sourceDeviceId: deviceId, deleted: false,
      })
      await tx.update(objects).set({
        currentRevision: resolvedRevision,
        parentObjectId: resolvedParentObjectId,
        nameCiphertext: resolvedNameCiphertext,
        nameBlindIndex: resolvedNameBlindIndex,
        ciphertext: command.objectResolution.ciphertext,
        ciphertextHash: command.objectResolution.ciphertextHash,
        keyVersion: command.objectResolution.keyVersion, blobRefs: resolvedBlobRefs,
        deletedAt: null, updatedAt: new Date(),
      }).where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectId, object.objectId)))
      if (resolvedResourceRevisions.size > 0) {
        await tx.insert(syncResourceBindings).values(Array.from(
          resolvedResourceRevisions,
          ([resourceObjectId, resourceRevision]) => ({
            workspaceId, ownerObjectId: object.objectId, ownerRevision: resolvedRevision!,
            resourceObjectId, resourceRevision,
          }),
        ))
      }
      await insertEvent(tx, {
        workspaceId, sequence: objectSequence, commandId: command.commandId, deviceId,
        type: 'object.upserted', objectId: object.objectId, keyVersion: command.objectResolution.keyVersion,
        ciphertext: command.objectResolution.ciphertext, ciphertextHash: command.objectResolution.ciphertextHash,
        metadata: { kind: object.kind, revision: resolvedRevision.toString(),
          blobRefs: resolvedBlobRefs,
          parentObjectId: resolvedParentObjectId, conflictId: conflict.conflictId },
      })
    }
    if (command.deleteObject === true) {
      if (conflict.type === 'delete-subtree-vs-edit') {
        throw new ApiError({
          code: 'subtree_resolution_requires_retry',
          message: 'Refresh and retry the atomic subtree delete before closing this conflict',
          statusCode: 409,
        })
      }
      const [object] = await tx.select().from(objects).where(and(
        eq(objects.workspaceId, workspaceId), eq(objects.objectId, conflict.objectId),
      )).limit(1).for('update')
      if (object === undefined || object.deletedAt !== null || (conflict.expectedRevision !== null
        && object.currentRevision !== conflict.expectedRevision)) {
        return { commandId: command.commandId, status: 'conflict', duplicate: false, code: 'conflict_changed' }
      }
      const revision = object.currentRevision + 1n
      const deleteSequence = await nextSequence(tx, workspaceId)
      await this.usage?.applyCurrentObject(tx, {
        accountId,
        previousBytes: BigInt(Buffer.from(object.ciphertext, 'base64url').byteLength), previousActive: true,
        nextBytes: 0n, nextActive: false, storageLimit,
      })
      await tx.insert(objectVersions).values({
        workspaceId, objectId: object.objectId, revision, sequence: deleteSequence, kind: object.kind,
        parentObjectId: object.parentObjectId, nameCiphertext: object.nameCiphertext,
        nameBlindIndex: object.nameBlindIndex,
        ciphertext: object.ciphertext, ciphertextHash: object.ciphertextHash, keyVersion: object.keyVersion,
        blobRefs: object.blobRefs, sourceDeviceId: deviceId, deleted: true,
      })
      await tx.update(objects).set({ currentRevision: revision, deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectId, object.objectId)))
      await insertEvent(tx, {
        workspaceId, sequence: deleteSequence, commandId: command.commandId, deviceId,
        type: 'object.deleted', objectId: object.objectId, keyVersion: object.keyVersion,
        ciphertext: object.ciphertext, ciphertextHash: object.ciphertextHash,
        metadata: { kind: object.kind, revision: revision.toString(), blobRefs: object.blobRefs,
          conflictId: conflict.conflictId },
      })
    }
    if (command.resolution !== undefined) {
      const document = resolutionDocument
      if (document === undefined) throw new Error('Validated conflict document disappeared')
      const documentSequence = document.latestDocumentSequence + 1n
      const checkpointSequence = await nextSequence(tx, workspaceId)
      await tx.insert(syncCheckpoints).values({
        workspaceId, checkpointId: command.resolution.checkpointId,
        documentId: command.resolution.documentId, objectId: conflict.objectId,
        coversDocumentSequence: documentSequence, eventSequence: checkpointSequence,
        materializedRevision: resolvedRevision, keyVersion: command.resolution.keyVersion,
        ciphertext: command.resolution.ciphertext, ciphertextHash: command.resolution.ciphertextHash,
        sourceDeviceId: deviceId,
      })
      await tx.update(syncDocuments).set({
        latestDocumentSequence: documentSequence, checkpointDocumentSequence: documentSequence,
        checkpointId: command.resolution.checkpointId, checkpointKeyVersion: command.resolution.keyVersion,
        checkpointCiphertext: command.resolution.ciphertext,
        checkpointCiphertextHash: command.resolution.ciphertextHash,
        materializedRevision: resolvedRevision, updatedAt: new Date(),
      }).where(and(eq(syncDocuments.workspaceId, workspaceId), eq(syncDocuments.documentId, command.resolution.documentId)))
      const prunedBytes = await this.#pruneCoveredUpdates(tx, workspaceId, command.resolution.documentId, documentSequence)
      await this.usage?.applyActiveCrdtDelta(tx, accountId,
        BigInt(Buffer.from(command.resolution.ciphertext, 'base64url').byteLength)
          - BigInt(document.checkpointCiphertext === null ? 0 : Buffer.from(document.checkpointCiphertext, 'base64url').byteLength)
          - prunedBytes,
        storageLimit)
      await insertEvent(tx, {
        workspaceId, sequence: checkpointSequence, commandId: command.commandId, deviceId,
        type: 'document.checkpointed', objectId: conflict.objectId,
        documentId: command.resolution.documentId, documentSequence,
        keyVersion: command.resolution.keyVersion, ciphertext: command.resolution.ciphertext,
        ciphertextHash: command.resolution.ciphertextHash,
        metadata: { checkpointId: command.resolution.checkpointId, kind: conflict.kind, conflictId: conflict.conflictId },
      })
    }
    const sequence = await nextSequence(tx, workspaceId)
    await tx.update(syncConflicts).set({
      status: 'resolved', resolvedSequence: sequence, resolvedByDeviceId: deviceId,
      resolvedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(syncConflicts.workspaceId, workspaceId), eq(syncConflicts.conflictId, command.conflictId)))
    await insertEvent(tx, {
      workspaceId, sequence, commandId: command.commandId, deviceId, type: 'conflict.resolved',
      objectId: conflict.objectId, metadata: { conflictId: command.conflictId },
    })
    return { commandId: command.commandId, status: 'applied', duplicate: false, sequence: sequence.toString(), conflictId: command.conflictId }
  }

  async #assertKeyAndBlobs(tx: SyncTransaction, workspaceId: string, keyVersion: number, blobRefs: string[]) {
    const [key] = await tx.select().from(workspaceKeys).where(and(eq(workspaceKeys.workspaceId, workspaceId), eq(workspaceKeys.keyVersion, keyVersion))).limit(1)
    if (key === undefined) throw new ApiError({ code: 'key_version_not_found', message: 'Workspace key version not found', statusCode: 409 })
    for (const blobId of new Set(blobRefs)) {
      const [blob] = await tx.select({ blobId: blobs.blobId }).from(blobs).where(and(
        eq(blobs.workspaceId, workspaceId), eq(blobs.blobId, blobId), eq(blobs.state, 'ready'),
      )).limit(1)
      if (blob === undefined) throw new ApiError({ code: 'blob_not_ready', message: 'Referenced blob is not ready', statusCode: 409, retryable: true })
    }
  }

  async #assertValidParent(tx: SyncTransaction, workspaceId: string, objectId: string, parentObjectId: string | null) {
    if (parentObjectId === null) return
    if (parentObjectId === objectId) throw new ApiError({ code: 'object_hierarchy_cycle', message: 'An object cannot be its own parent', statusCode: 409 })
    let cursor: string | null = parentObjectId
    const visited = new Set<string>()
    while (cursor !== null) {
      if (cursor === objectId || visited.has(cursor)) {
        throw new ApiError({ code: 'object_hierarchy_cycle', message: 'Object move would create a hierarchy cycle', statusCode: 409 })
      }
      visited.add(cursor)
      const [parent] = await tx.select({
        kind: objects.kind, deletedAt: objects.deletedAt, parentObjectId: objects.parentObjectId,
      }).from(objects).where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectId, cursor))).limit(1)
      if (parent === undefined || parent.deletedAt !== null || parent.kind !== 'folder') {
        throw new ApiError({ code: 'object_parent_invalid', message: 'Parent must be an active folder in this workspace', statusCode: 409 })
      }
      cursor = parent.parentObjectId
    }
  }

  async #pruneCoveredUpdates(tx: SyncTransaction, workspaceId: string, documentId: string, covers: bigint): Promise<bigint> {
    const [activeBootstrap] = await tx.select({ id: syncBootstrapSessions.id }).from(syncBootstrapSessions).where(and(
      eq(syncBootstrapSessions.workspaceId, workspaceId), gt(syncBootstrapSessions.expiresAt, new Date()),
    )).limit(1)
    if (activeBootstrap !== undefined) return 0n
    const removed = await tx.select({ ciphertext: syncUpdates.ciphertext }).from(syncUpdates).where(and(
      eq(syncUpdates.workspaceId, workspaceId), eq(syncUpdates.documentId, documentId),
      sql`${syncUpdates.documentSequence} <= ${covers}`,
    ))
    await tx.delete(syncUpdates).where(and(
      eq(syncUpdates.workspaceId, workspaceId), eq(syncUpdates.documentId, documentId),
      sql`${syncUpdates.documentSequence} <= ${covers}`,
    ))
    return removed.reduce((total, row) => total + BigInt(Buffer.from(row.ciphertext, 'base64url').byteLength), 0n)
  }

  #validateEnvelope(envelope: CiphertextEnvelope) {
    this.#validateCiphertext(envelope.ciphertext, envelope.ciphertextHash)
  }

  #validateCiphertext(ciphertext: string, expectedHash: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(ciphertext)) throw new ApiError({ code: 'request_invalid', message: 'Ciphertext must be Base64URL', statusCode: 400 })
    const bytes = Buffer.from(ciphertext, 'base64url')
    if (bytes.byteLength > this.currentMaxObjectBytes()) throw new ApiError({ code: 'object_too_large', message: 'Ciphertext exceeds the configured limit', statusCode: 413 })
    if (createHash('sha256').update(bytes).digest('base64url') !== expectedHash) {
      throw new ApiError({ code: 'ciphertext_hash_mismatch', message: 'Ciphertext hash does not match', statusCode: 422 })
    }
  }

  private currentMaxObjectBytes(): number {
    return typeof this.maxObjectBytes === 'function' ? this.maxObjectBytes() : this.maxObjectBytes
  }

}

type SyncTransaction = Parameters<Parameters<DatabaseContext['db']['transaction']>[0]>[0]

async function nextSequence(tx: SyncTransaction, workspaceId: string): Promise<bigint> {
  const [row] = await tx.update(workspaces).set({
    latestSequence: sql`${workspaces.latestSequence} + 1`, updatedAt: new Date(),
  }).where(eq(workspaces.id, workspaceId)).returning({ sequence: workspaces.latestSequence })
  if (row === undefined) throw new Error('Workspace sequence update returned no row')
  return row.sequence
}

async function insertEvent(tx: SyncTransaction, input: {
  workspaceId: string
  sequence: bigint
  commandId: string
  deviceId: string
  type: string
  objectId?: string
  documentId?: string
  documentSequence?: bigint
  keyVersion?: number
  ciphertext?: string
  ciphertextHash?: string
  metadata?: Record<string, unknown>
}) {
  await tx.insert(syncEvents).values({
    workspaceId: input.workspaceId, sequence: input.sequence, commandId: input.commandId,
    sourceDeviceId: input.deviceId, type: input.type,
    ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
    ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
    ...(input.documentSequence === undefined ? {} : { documentSequence: input.documentSequence }),
    ...(input.keyVersion === undefined ? {} : { keyVersion: input.keyVersion }),
    ...(input.ciphertext === undefined ? {} : { ciphertext: input.ciphertext }),
    ...(input.ciphertextHash === undefined ? {} : { ciphertextHash: input.ciphertextHash }),
    metadata: input.metadata ?? {},
  })
}

function counter(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new ApiError({ code: 'request_invalid', message: `${field} must be an unsigned integer string`, statusCode: 400 })
  return BigInt(value)
}

function serializeEvent(row: typeof syncEvents.$inferSelect) {
  return {
    eventId: row.eventId,
    commandId: row.commandId,
    sourceDeviceId: row.sourceDeviceId,
    type: row.type,
    objectId: row.objectId,
    documentId: row.documentId,
    sequence: row.sequence.toString(),
    documentSequence: row.documentSequence?.toString() ?? null,
    keyVersion: row.keyVersion,
    ciphertext: row.ciphertext,
    ciphertextHash: row.ciphertextHash,
    metadata: row.metadata,
    createdAt: row.createdAt,
  }
}

function serializeObjectVersion(row: typeof objectVersions.$inferSelect) {
  return {
    ...row,
    revision: row.revision.toString(),
    sequence: row.sequence.toString(),
  }
}

function serializeConflict(row: typeof syncConflicts.$inferSelect) {
  return {
    ...row,
    expectedRevision: row.expectedRevision?.toString() ?? null,
    expectedDocumentSequence: row.expectedDocumentSequence?.toString() ?? null,
    createdSequence: row.createdSequence.toString(),
    resolvedSequence: row.resolvedSequence?.toString() ?? null,
  }
}
