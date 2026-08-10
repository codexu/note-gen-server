import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const baseUrl = process.env.INTEGRATION_BASE_URL
const integration = baseUrl === undefined ? describe.skip : describe
integration('NoteGen sync protocol durability', () => {
  it('deduplicates commands and turns delete-after-edit into a durable conflict', async () => {
    if (baseUrl === undefined) throw new Error('INTEGRATION_BASE_URL is required')
    const deviceId = randomUUID()
    const session = await api<Session>(baseUrl, '/v1/auth/register', {
      method: 'POST', expectedStatus: 201,
      headers: { 'x-setup-token': process.env.INTEGRATION_SETUP_TOKEN ?? 'integration-setup-token' },
      body: {
        login: `sync-${randomUUID()}@example.test`, password: 'integration-password',
        deviceId, deviceName: 'Sync integration device', platform: 'test',
      },
    })
    const authorization = { authorization: `Bearer ${session.accessToken}` }
    const workspace = await api<{ id: string }>(baseUrl, '/v1/workspaces', {
      method: 'POST', expectedStatus: 201, headers: authorization,
      body: {
        nameCiphertext: 'sync-test-workspace', keyVersion: 1,
        envelopes: [{ type: 'passphrase', recipientId: null, wrappedKey: 'test-envelope',
          kdfSalt: 'test-salt', kdfParams: { memorySize: 65536, iterations: 3, parallelism: 1 } },
        { type: 'recovery', recipientId: null, wrappedKey: 'test-recovery-envelope',
          kdfSalt: null, kdfParams: null }],
      },
    })
    const objectId = randomUUID()
    const objectEnvelope = encryptedTestEnvelope('object-v1')
    const command = {
      type: 'upsert-object', commandId: randomUUID(), objectId, kind: 'note',
      parentObjectId: null, nameCiphertext: objectEnvelope.ciphertext,
      baseRevision: null, blobRefs: [], keyVersion: 1, ...objectEnvelope,
    }
    const first = await syncCommands(baseUrl, workspace.id, authorization, [command])
    const retried = await syncCommands(baseUrl, workspace.id, authorization, [command])
    expect(first[0]).toMatchObject({ status: 'applied', duplicate: false, revision: '1' })
    expect(retried[0]).toMatchObject({ status: 'applied', duplicate: true, revision: '1' })

    const documentId = `note:${objectId}`
    const updateEnvelope = encryptedTestEnvelope('durable-yjs-update')
    const updateId = randomUUID()
    const update = { type: 'append-update', commandId: randomUUID(), updateId,
      documentId, objectId, kind: 'note', keyVersion: 1, ...updateEnvelope }
    const updateResult = await syncCommands(baseUrl, workspace.id, authorization, [update])
    expect(updateResult[0]).toMatchObject({ status: 'applied', documentSequence: '1' })

    const conflictId = randomUUID()
    const conflictEnvelope = encryptedTestEnvelope('delete-edit-conflict')
    const deletion = { type: 'delete-object', commandId: randomUUID(), objectId, kind: 'note',
      baseRevision: '1', expectedDocumentSequence: '0', blobRefs: [], keyVersion: 1,
      conflictId, conflictCiphertext: conflictEnvelope.ciphertext,
      conflictCiphertextHash: conflictEnvelope.ciphertextHash, ...objectEnvelope }
    const deleteResult = await syncCommands(baseUrl, workspace.id, authorization, [deletion])
    expect(deleteResult[0]).toMatchObject({ status: 'conflict', code: 'delete_edit_conflict', conflictId })
    const events = await api<{ events: Array<{ type: string }> }>(
      baseUrl, `/v1/workspaces/${workspace.id}/sync/events?after=0`, { headers: authorization },
    )
    expect(events.events.map(event => event.type)).toContain('conflict.created')

    const folderCommands = [randomUUID(), randomUUID()].map((folderId, index) => {
      const envelope = encryptedTestEnvelope(`folder-${index}`)
      return { type: 'upsert-object', commandId: randomUUID(), objectId: folderId, kind: 'folder',
        parentObjectId: null, nameCiphertext: envelope.ciphertext, baseRevision: null,
        blobRefs: [], keyVersion: 1, ...envelope }
    })
    await syncCommands(baseUrl, workspace.id, authorization, folderCommands)
    const firstBootstrap = await api<{
      bootstrapId: string, snapshotSequence: string, objects: Array<{ objectId: string }>,
      nextObjectId: string | null, hasMore: boolean,
    }>(baseUrl, `/v1/workspaces/${workspace.id}/sync/bootstrap?limit=1`, { headers: authorization })
    expect(firstBootstrap.hasMore).toBe(true)
    const laterObjectId = randomUUID()
    const laterEnvelope = encryptedTestEnvelope('created-after-bootstrap')
    await syncCommands(baseUrl, workspace.id, authorization, [{
      type: 'upsert-object', commandId: randomUUID(), objectId: laterObjectId, kind: 'folder',
      parentObjectId: null, nameCiphertext: laterEnvelope.ciphertext, baseRevision: null,
      blobRefs: [], keyVersion: 1, ...laterEnvelope,
    }])
    const snapshotObjectIds = [...firstBootstrap.objects.map(item => item.objectId)]
    let afterObjectId = firstBootstrap.nextObjectId
    while (afterObjectId) {
      const page = await api<{
        bootstrapId: string, snapshotSequence: string, objects: Array<{ objectId: string }>,
        nextObjectId: string | null, hasMore: boolean,
      }>(baseUrl, `/v1/workspaces/${workspace.id}/sync/bootstrap?limit=1&bootstrapId=${firstBootstrap.bootstrapId}&afterObjectId=${afterObjectId}`,
      { headers: authorization })
      expect(page.bootstrapId).toBe(firstBootstrap.bootstrapId)
      expect(page.snapshotSequence).toBe(firstBootstrap.snapshotSequence)
      snapshotObjectIds.push(...page.objects.map(item => item.objectId))
      afterObjectId = page.nextObjectId
    }
    expect(snapshotObjectIds).not.toContain(laterObjectId)

    const hijackEnvelope = encryptedTestEnvelope('document-id-hijack')
    const hijack = await syncCommands(baseUrl, workspace.id, authorization, [{
      type: 'append-update', commandId: randomUUID(), updateId: randomUUID(),
      documentId, objectId: folderCommands[0]!.objectId, kind: 'folder', keyVersion: 1, ...hijackEnvelope,
    }])
    expect(hijack[0]).toMatchObject({ status: 'rejected', code: 'document_identity_mismatch' })

    const subtreeRootId = randomUUID()
    const subtreeNoteId = randomUUID()
    const subtreeRootEnvelope = encryptedTestEnvelope('subtree-root')
    const subtreeNoteEnvelope = encryptedTestEnvelope('subtree-note')
    await syncCommands(baseUrl, workspace.id, authorization, [{
      type: 'upsert-object', commandId: randomUUID(), objectId: subtreeRootId, kind: 'folder',
      parentObjectId: null, nameCiphertext: subtreeRootEnvelope.ciphertext, baseRevision: null,
      blobRefs: [], keyVersion: 1, ...subtreeRootEnvelope,
    }, {
      type: 'upsert-object', commandId: randomUUID(), objectId: subtreeNoteId, kind: 'note',
      parentObjectId: subtreeRootId, nameCiphertext: subtreeNoteEnvelope.ciphertext, baseRevision: null,
      blobRefs: [], keyVersion: 1, ...subtreeNoteEnvelope,
    }])
    const subtreeUpdateEnvelope = encryptedTestEnvelope('subtree-concurrent-edit')
    await syncCommands(baseUrl, workspace.id, authorization, [{
      type: 'append-update', commandId: randomUUID(), updateId: randomUUID(),
      documentId: `note:${subtreeNoteId}`, objectId: subtreeNoteId, kind: 'note',
      keyVersion: 1, ...subtreeUpdateEnvelope,
    }])
    const subtreeConflictId = randomUUID()
    const subtreeConflictEnvelope = encryptedTestEnvelope('subtree-delete-conflict')
    const subtreeDelete = await syncCommands(baseUrl, workspace.id, authorization, [{
      type: 'delete-subtree', commandId: randomUUID(), rootObjectId: subtreeRootId,
      conflictId: subtreeConflictId, conflictKeyVersion: 1,
      conflictCiphertext: subtreeConflictEnvelope.ciphertext,
      conflictCiphertextHash: subtreeConflictEnvelope.ciphertextHash,
      objects: [{ objectId: subtreeRootId, kind: 'folder', baseRevision: '1',
        expectedDocumentSequence: '0', blobRefs: [], keyVersion: 1, ...subtreeRootEnvelope },
      { objectId: subtreeNoteId, kind: 'note', baseRevision: '1',
        expectedDocumentSequence: '0', blobRefs: [], keyVersion: 1, ...subtreeNoteEnvelope }],
    }])
    expect(subtreeDelete[0]).toMatchObject({
      status: 'conflict', code: 'delete_edit_conflict', conflictId: subtreeConflictId,
    })
    const afterSubtreeConflict = await api<{ objects: Array<{ objectId: string, deletedAt: string | null }> }>(
      baseUrl, `/v1/workspaces/${workspace.id}/sync/bootstrap?limit=1000`, { headers: authorization },
    )
    expect(afterSubtreeConflict.objects.find(item => item.objectId === subtreeRootId)?.deletedAt).toBeNull()
    expect(afterSubtreeConflict.objects.find(item => item.objectId === subtreeNoteId)?.deletedAt).toBeNull()
  }, 30_000)
})

function encryptedTestEnvelope(value: string) {
  const bytes = Buffer.from(value)
  return {
    ciphertext: bytes.toString('base64url'),
    ciphertextHash: createHash('sha256').update(bytes).digest('base64url'),
  }
}

async function syncCommands(origin: string, workspaceId: string, headers: Record<string, string>, commands: unknown[]) {
  const response = await api<{ results: Array<Record<string, unknown>> }>(
    origin, `/v1/workspaces/${workspaceId}/sync/commands`, { method: 'POST', headers, body: { commands } },
  )
  return response.results
}

interface Session { accessToken: string }

async function api<T>(
  origin: string,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    expectedStatus?: number
  } = {},
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  expect(response.status, await response.clone().text()).toBe(options.expectedStatus ?? 200)
  return await response.json() as T
}
