import { createHash, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

const baseUrl = process.env.INTEGRATION_BASE_URL
const integration = baseUrl === undefined ? describe.skip : describe
integration('NoteGen sync protocol durability', () => {
  beforeAll(async () => {
    if (baseUrl !== undefined) await prepareIntegrationInstance(baseUrl)
  }, 30_000)

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
        nameCiphertext: 'sync-test-workspace',
        managedKey: Buffer.alloc(32, 1).toString('base64url'),
      },
    })
    const protocolSession = await api<{ syncEpoch: string }>(
      baseUrl,
      `/v1/workspaces/${workspace.id}/sync/session?protocolVersion=1&cursor=0`,
      { headers: authorization },
    )
    syncEpochs.set(workspace.id, protocolSession.syncEpoch)
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
      baseUrl, `/v1/workspaces/${workspace.id}/sync/events?after=0&expectedSyncEpoch=${syncEpoch(workspace.id)}`, { headers: authorization },
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
    }>(baseUrl, `/v1/workspaces/${workspace.id}/sync/bootstrap?limit=1&expectedSyncEpoch=${syncEpoch(workspace.id)}`, { headers: authorization })
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
      }>(baseUrl, `/v1/workspaces/${workspace.id}/sync/bootstrap?limit=1&expectedSyncEpoch=${syncEpoch(workspace.id)}&bootstrapId=${firstBootstrap.bootstrapId}&afterObjectId=${afterObjectId}`,
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
      baseUrl, `/v1/workspaces/${workspace.id}/sync/bootstrap?limit=1000&expectedSyncEpoch=${syncEpoch(workspace.id)}`, { headers: authorization },
    )
    expect(afterSubtreeConflict.objects.find(item => item.objectId === subtreeRootId)?.deletedAt).toBeNull()
    expect(afterSubtreeConflict.objects.find(item => item.objectId === subtreeNoteId)?.deletedAt).toBeNull()
  }, 30_000)

  it('enforces member capabilities, invitation revocation, and removal', async () => {
    if (baseUrl === undefined) throw new Error('INTEGRATION_BASE_URL is required')
    const owner = await registerIntegrationAccount(baseUrl, 'owner')
    const viewer = await registerIntegrationAccount(baseUrl, 'viewer')
    const workspace = await api<{ id: string }>(baseUrl, '/v1/workspaces', {
      method: 'POST', expectedStatus: 201, headers: owner.headers,
      body: {
        nameCiphertext: 'shared-library',
        managedKey: Buffer.alloc(32, 2).toString('base64url'),
      },
    })
    const invitation = await api<{ id: string }>(
      baseUrl, `/v1/workspaces/${workspace.id}/invitations/account`, {
        method: 'POST', expectedStatus: 201, headers: owner.headers,
        body: { login: viewer.login, role: 'viewer' },
      },
    )
    await api(baseUrl, `/v1/workspace-invitations/${invitation.id}/accept`, {
      method: 'POST', headers: viewer.headers,
    })
    const session = await api<{ syncEpoch: string }>(
      baseUrl, `/v1/workspaces/${workspace.id}/sync/session?protocolVersion=1&cursor=0`,
      { headers: viewer.headers },
    )
    syncEpochs.set(workspace.id, session.syncEpoch)
    const envelope = encryptedTestEnvelope('viewer-write')
    const [rejected] = await syncCommands(baseUrl, workspace.id, viewer.headers, [{
      type: 'upsert-object', commandId: randomUUID(), objectId: randomUUID(), kind: 'note',
      parentObjectId: null, nameCiphertext: envelope.ciphertext, baseRevision: null,
      blobRefs: [], keyVersion: 1, ...envelope,
    }])
    expect(rejected).toMatchObject({ status: 'rejected', code: 'workspace_capability_denied' })

    const link = await api<{ id: string; token: string }>(
      baseUrl, `/v1/workspaces/${workspace.id}/invitations/link`, {
        method: 'POST', expectedStatus: 201, headers: owner.headers,
        body: { role: 'editor' },
      },
    )
    await api(baseUrl, `/v1/workspaces/${workspace.id}/invitations/${link.id}`, {
      method: 'DELETE', expectedStatus: 204, headers: owner.headers,
    })
    await api(baseUrl, '/v1/workspace-invitations/accept-link', {
      method: 'POST', expectedStatus: 404, headers: viewer.headers, body: { token: link.token },
    })

    await api(baseUrl, `/v1/workspaces/${workspace.id}/members/${viewer.accountId}`, {
      method: 'DELETE', expectedStatus: 204, headers: owner.headers,
    })
    await api(baseUrl, `/v1/workspaces/${workspace.id}/sync/session?protocolVersion=1&cursor=0`, {
      expectedStatus: 404, headers: viewer.headers,
    })
  }, 30_000)
})

async function prepareIntegrationInstance(origin: string): Promise<void> {
  const statusResponse = await fetch(`${origin}/v1/installation/status`)
  expect(statusResponse.status, await statusResponse.clone().text()).toBe(200)
  const status = await statusResponse.json() as { installationRequired: boolean }
  if (!status.installationRequired) return

  const login = `admin-${randomUUID()}@example.test`
  const password = 'integration-password'
  const installationResponse = await fetch(`${origin}/v1/installation/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverName: 'NoteGen CI Server',
      administrator: { login, password },
    }),
  })
  expect(installationResponse.status, await installationResponse.clone().text()).toBe(201)

  const loginResponse = await waitForInstalledServer(origin, login, password)
  const cookies = loginResponse.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]!)
  const csrfCookie = cookies.find(cookie => cookie.startsWith('notegen_csrf='))
  if (csrfCookie === undefined) throw new Error('Installation login did not return a CSRF cookie')
  const csrfToken = decodeURIComponent(csrfCookie.slice('notegen_csrf='.length))
  const cookieHeader = cookies.join('; ')
  const requestHash = createHash('sha256').update('{"policy":"public"}').digest('base64url')
  const stepUpResponse = await fetch(`${origin}/v1/web/auth/step-up`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({
      audience: 'registration.policy.update',
      requestHash,
      password,
    }),
  })
  expect(stepUpResponse.status, await stepUpResponse.clone().text()).toBe(201)
  const stepUp = await stepUpResponse.json() as { token: string }
  const policyResponse = await fetch(`${origin}/v1/web/admin/registration-policy`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
      'x-csrf-token': csrfToken,
      'x-step-up-token': stepUp.token,
    },
    body: JSON.stringify({ policy: 'public' }),
  })
  expect(policyResponse.status, await policyResponse.clone().text()).toBe(204)
}

async function waitForInstalledServer(origin: string, login: string, password: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${origin}/v1/web/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login, password }),
      })
      if (response.status === 200) return response
      if (![404, 503].includes(response.status)) {
        throw new Error(`Installed server login failed: ${response.status} ${await response.text()}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Installed server login failed:')) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Installed server did not become ready')
}

function encryptedTestEnvelope(value: string) {
  const bytes = Buffer.from(value)
  return {
    ciphertext: bytes.toString('base64url'),
    ciphertextHash: createHash('sha256').update(bytes).digest('base64url'),
  }
}

async function syncCommands(origin: string, workspaceId: string, headers: Record<string, string>, commands: unknown[]) {
  const response = await api<{ results: Array<Record<string, unknown>> }>(
    origin, `/v1/workspaces/${workspaceId}/sync/commands`, {
      method: 'POST', headers, body: { commands, expectedSyncEpoch: syncEpoch(workspaceId) },
    },
  )
  return response.results
}

const syncEpochs = new Map<string, string>()

function syncEpoch(workspaceId: string) {
  const value = syncEpochs.get(workspaceId)
  if (!value) throw new Error(`Missing sync epoch for ${workspaceId}`)
  return value
}

interface Session { accessToken: string }

async function registerIntegrationAccount(origin: string, label: string) {
  const login = `${label}-${randomUUID()}@example.test`
  const session = await api<Session>(origin, '/v1/auth/register', {
    method: 'POST', expectedStatus: 201,
    headers: { 'x-setup-token': process.env.INTEGRATION_SETUP_TOKEN ?? 'integration-setup-token' },
    body: {
      login, password: 'integration-password', deviceId: randomUUID(),
      deviceName: `${label} integration device`, platform: 'test',
    },
  })
  const headers = { authorization: `Bearer ${session.accessToken}` }
  const account = await api<{ id: string }>(origin, '/v1/account', { headers })
  return { login, accountId: account.id, headers }
}

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
  if (response.status === 204) return undefined as T
  return await response.json() as T
}
