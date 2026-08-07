import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const baseUrl = process.env.INTEGRATION_BASE_URL
const integration = baseUrl === undefined ? describe.skip : describe

integration('live server synchronization flow', () => {
  it('converges through auth, blobs, revisions, bootstrap, history and websocket notifications', async () => {
    if (baseUrl === undefined) throw new Error('INTEGRATION_BASE_URL is required')
    const login = `integration-${randomUUID()}@example.test`
    const deviceId = randomUUID()
    const session = await request<Session>(baseUrl, '/v1/auth/register', {
      method: 'POST',
      headers: { 'x-setup-token': process.env.INTEGRATION_SETUP_TOKEN ?? 'integration-setup-token' },
      body: {
        login, password: 'integration-password', deviceId,
        deviceName: 'Integration Device', platform: 'test',
      },
      expectedStatus: 201,
    })
    const authorization = { authorization: `Bearer ${session.accessToken}` }

    const workspace = await request<{ id: string }>(baseUrl, '/v1/workspaces', {
      method: 'POST', headers: authorization, expectedStatus: 201,
      body: {
        nameCiphertext: 'encrypted-workspace-name',
        keyVersion: 1,
        envelopes: [
          {
            type: 'passphrase', recipientId: null, wrappedKey: 'wrapped-by-passphrase',
            kdfSalt: 'salt', kdfParams: { memory: 65536, iterations: 3 },
          },
          {
            type: 'recovery', recipientId: null, wrappedKey: 'wrapped-by-recovery',
            kdfSalt: null, kdfParams: null,
          },
        ],
      },
    })

    const duplicateEnvelope = await request<{ code: string }>(baseUrl, '/v1/workspaces', {
      method: 'POST', headers: authorization, expectedStatus: 400,
      body: {
        nameCiphertext: 'invalid-workspace',
        keyVersion: 1,
        envelopes: [
          {
            type: 'passphrase', recipientId: null, wrappedKey: 'first',
            kdfSalt: 'salt', kdfParams: { memory: 65536, iterations: 3 },
          },
          {
            type: 'passphrase', recipientId: null, wrappedKey: 'duplicate',
            kdfSalt: 'salt', kdfParams: { memory: 65536, iterations: 3 },
          },
          {
            type: 'recovery', recipientId: null, wrappedKey: 'recovery',
            kdfSalt: null, kdfParams: null,
          },
        ],
      },
    })
    expect(duplicateEnvelope.code).toBe('key_envelope_duplicate')

    const blobContent = Buffer.from('encrypted attachment payload')
    const blobId = createHash('sha256').update('plaintext attachment').digest('base64url')
    const ciphertextHash = createHash('sha256').update(blobContent).digest('base64url')
    const upload = await request<{ uploadId: string }>(
      baseUrl,
      `/v1/workspaces/${workspace.id}/blobs/uploads`,
      {
        method: 'POST', headers: authorization, expectedStatus: 201,
        body: { blobId, expectedSize: String(blobContent.byteLength), ciphertextHash },
      },
    )
    await request(baseUrl, `/v1/workspaces/${workspace.id}/blobs/uploads/${upload.uploadId}/parts/1`, {
      method: 'PUT',
      headers: { ...authorization, 'content-type': 'application/octet-stream' },
      rawBody: blobContent,
    })
    const uploadStatus = await request<{ uploadedParts: Array<{ partNumber: number }> }>(
      baseUrl, `/v1/workspaces/${workspace.id}/blobs/uploads/${upload.uploadId}`,
      { headers: authorization },
    )
    expect(uploadStatus.uploadedParts).toEqual([expect.objectContaining({ partNumber: 1 })])
    const resumedUpload = await request<{ uploadId: string, resumed: boolean }>(
      baseUrl,
      `/v1/workspaces/${workspace.id}/blobs/uploads`,
      {
        method: 'POST', headers: authorization,
        body: { blobId, expectedSize: String(blobContent.byteLength), ciphertextHash },
      },
    )
    expect(resumedUpload).toMatchObject({ uploadId: upload.uploadId, resumed: true })
    const concurrentCompletes = await Promise.all([1, 2].map(() => fetch(
      `${baseUrl}/v1/workspaces/${workspace.id}/blobs/uploads/${upload.uploadId}/complete`,
      { method: 'POST', headers: authorization },
    )))
    expect(concurrentCompletes.some((response) => response.status === 200)).toBe(true)
    expect(concurrentCompletes.every((response) => response.status === 200 || response.status === 409)).toBe(true)
    await request(baseUrl, `/v1/workspaces/${workspace.id}/blobs/uploads/${upload.uploadId}/complete`, {
      method: 'POST', headers: authorization,
    })
    const downloaded = await fetch(`${baseUrl}/v1/workspaces/${workspace.id}/blobs/${blobId}`, {
      headers: authorization,
    })
    expect(downloaded.status).toBe(200)
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(blobContent)

    const noteId = randomUUID()
    const firstOperationId = randomUUID()
    const firstCiphertext = Buffer.from('encrypted-note-v1').toString('base64url')
    const firstOperation = {
      operationId: firstOperationId,
      objectId: noteId,
      kind: 'note',
      baseRevision: null,
      keyVersion: 1,
      ciphertext: firstCiphertext,
      ciphertextHash: createHash('sha256').update(Buffer.from(firstCiphertext, 'base64url')).digest('base64url'),
      blobRefs: [blobId],
      delete: false,
    }
    const missingKey = await request<PushResponse>(
      baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
        method: 'POST', headers: authorization,
        body: { operations: [{ ...firstOperation, operationId: randomUUID(), keyVersion: 999 }] },
      },
    )
    expect(missingKey.results[0]).toMatchObject({ status: 'rejected', code: 'key_version_not_found' })

    const firstPush = await request<PushResponse>(baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
      method: 'POST', headers: authorization, body: { operations: [firstOperation] },
    })
    expect(firstPush.results[0]).toMatchObject({ status: 'applied', revision: '1', duplicate: false })

    const reusedCiphertext = Buffer.from('different-operation-payload').toString('base64url')
    const reusedOperation = await request<PushResponse>(
      baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
        method: 'POST', headers: authorization,
        body: {
          operations: [{
            ...firstOperation,
            ciphertext: reusedCiphertext,
            ciphertextHash: createHash('sha256')
              .update(Buffer.from(reusedCiphertext, 'base64url')).digest('base64url'),
          }],
        },
      },
    )
    expect(reusedOperation.results[0]).toMatchObject({ status: 'rejected', code: 'operation_id_reused' })

    const duplicate = await request<PushResponse>(baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
      method: 'POST', headers: authorization, body: { operations: [firstOperation] },
    })
    expect(duplicate.results[0]).toMatchObject({ status: 'applied', revision: '1', duplicate: true })

    const conflict = await request<PushResponse>(baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
      method: 'POST', headers: authorization,
      body: { operations: [{ ...firstOperation, operationId: randomUUID(), baseRevision: null }] },
    })
    expect(conflict.results[0]).toMatchObject({ status: 'conflict' })

    const socket = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/v1/sync/events')
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({
      type: 'authenticate', accessToken: session.accessToken, workspaceIds: [workspace.id],
    }))
    expect(await nextSocketMessage(socket)).toMatchObject({ type: 'authenticated' })

    const noticePromise = nextSocketMessage(socket)
    const secondCiphertext = Buffer.from('encrypted-note-v2').toString('base64url')
    const secondPush = await request<PushResponse>(baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
      method: 'POST', headers: authorization,
      body: {
        operations: [{
          ...firstOperation,
          operationId: randomUUID(),
          baseRevision: '1',
          ciphertext: secondCiphertext,
          ciphertextHash: createHash('sha256').update(Buffer.from(secondCiphertext, 'base64url')).digest('base64url'),
        }],
      },
    })
    expect(secondPush.results[0]).toMatchObject({ status: 'applied', revision: '2' })
    expect(await noticePromise).toMatchObject({ type: 'workspace.changed', workspaceId: workspace.id })
    socket.close()

    const settingCiphertext = Buffer.from('encrypted-setting').toString('base64url')
    await request<PushResponse>(baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
      method: 'POST', headers: authorization,
      body: {
        operations: [{
          operationId: randomUUID(),
          objectId: randomUUID(),
          kind: 'setting',
          baseRevision: null,
          keyVersion: 1,
          ciphertext: settingCiphertext,
          ciphertextHash: createHash('sha256')
            .update(Buffer.from(settingCiphertext, 'base64url')).digest('base64url'),
          blobRefs: [],
          delete: false,
        }],
      },
    })

    const changes = await request<{ changes: Array<{ objectId: string, revision: string }> }>(
      baseUrl, `/v1/workspaces/${workspace.id}/sync/changes?after=0`, { headers: authorization },
    )
    expect(changes.changes.map((change) => change.revision)).toEqual(['1', '2', '1'])

    const firstBootstrap = await request<BootstrapResponse>(
      baseUrl, `/v1/workspaces/${workspace.id}/sync/bootstrap?limit=1`, { headers: authorization },
    )
    expect(firstBootstrap).toMatchObject({ hasMore: true })
    const secondBootstrap = await request<BootstrapResponse>(
      baseUrl,
      `/v1/workspaces/${workspace.id}/sync/bootstrap?limit=1&afterObjectId=${firstBootstrap.nextObjectId}&bootstrapSessionId=${firstBootstrap.bootstrapSessionId}`,
      { headers: authorization },
    )
    expect([...firstBootstrap.objects, ...secondBootstrap.objects]).toContainEqual(
      expect.objectContaining({ objectId: noteId, currentRevision: '2' }),
    )

    const restored = await request<{ status: string, revision: string }>(
      baseUrl, `/v1/workspaces/${workspace.id}/objects/${noteId}/history/1/restore`,
      {
        method: 'POST', headers: authorization,
        body: { operationId: randomUUID(), baseRevision: '2' },
      },
    )
    expect(restored).toMatchObject({ status: 'applied', revision: '3' })

    const refreshed = await request<Session>(baseUrl, '/v1/auth/refresh', {
      method: 'POST', body: { refreshToken: session.refreshToken, deviceId },
    })
    expect(refreshed.refreshToken).not.toBe(session.refreshToken)
    const replay = await request<{ code: string }>(baseUrl, '/v1/auth/refresh', {
      method: 'POST', expectedStatus: 401,
      body: { refreshToken: session.refreshToken, deviceId },
    })
    expect(replay.code).toBe('refresh_token_reused')
    const revoked = await request<{ code: string }>(baseUrl, '/v1/auth/refresh', {
      method: 'POST', expectedStatus: 401,
      body: { refreshToken: refreshed.refreshToken, deviceId },
    })
    expect(revoked.code).toBe('refresh_token_invalid')
    const revokedAccess = await request<{ code: string }>(baseUrl, '/v1/workspaces', {
      headers: authorization, expectedStatus: 401,
    })
    expect(revokedAccess.code).toBe('device_revoked')
  }, 30_000)

  it('serializes concurrent first writes and operation retries', async () => {
    if (baseUrl === undefined) throw new Error('INTEGRATION_BASE_URL is required')
    const session = await request<Session>(baseUrl, '/v1/auth/register', {
      method: 'POST',
      headers: { 'x-setup-token': process.env.INTEGRATION_SETUP_TOKEN ?? 'integration-setup-token' },
      body: {
        login: `integration-race-${randomUUID()}@example.test`, password: 'integration-password',
        deviceId: randomUUID(), deviceName: 'Concurrency Device', platform: 'test',
      },
      expectedStatus: 201,
    })
    const authorization = { authorization: `Bearer ${session.accessToken}` }
    const workspace = await request<{ id: string }>(baseUrl, '/v1/workspaces', {
      method: 'POST', headers: authorization, expectedStatus: 201,
      body: {
        nameCiphertext: 'encrypted-race-workspace', keyVersion: 1,
        envelopes: [
          {
            type: 'passphrase', recipientId: null, wrappedKey: 'passphrase',
            kdfSalt: 'salt', kdfParams: { memory: 65536, iterations: 3 },
          },
          {
            type: 'recovery', recipientId: null, wrappedKey: 'recovery',
            kdfSalt: null, kdfParams: null,
          },
        ],
      },
    })
    const ciphertext = Buffer.from('concurrent ciphertext').toString('base64url')
    const base = {
      kind: 'note', baseRevision: null, keyVersion: 1, ciphertext,
      ciphertextHash: createHash('sha256').update(Buffer.from(ciphertext, 'base64url')).digest('base64url'),
      blobRefs: [], delete: false,
    }

    const concurrentWrites = await Promise.all([randomUUID(), randomUUID()].map((operationId) => (
      request<PushResponse>(baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
        method: 'POST', headers: authorization,
        body: { operations: [{ ...base, objectId: workspace.id, operationId }] },
      })
    )))
    expect(concurrentWrites.map((response) => response.results[0]?.status).sort()).toEqual(['applied', 'conflict'])

    const retryOperation = { ...base, objectId: randomUUID(), operationId: randomUUID() }
    const concurrentRetries = await Promise.all([1, 2].map(() => (
      request<PushResponse>(baseUrl, `/v1/workspaces/${workspace.id}/sync/push`, {
        method: 'POST', headers: authorization, body: { operations: [retryOperation] },
      })
    )))
    expect(concurrentRetries.map((response) => response.results[0]?.duplicate).sort()).toEqual([false, true])
  }, 30_000)
})

interface Session {
  accessToken: string
  refreshToken: string
}

interface PushResponse {
  results: Array<Record<string, unknown>>
}

interface BootstrapResponse {
  objects: Array<{ objectId: string, currentRevision: string }>
  nextObjectId: string | null
  hasMore: boolean
  bootstrapSessionId: string | null
}

async function request<T = unknown>(
  origin: string,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    rawBody?: Buffer
    expectedStatus?: number
  } = {},
): Promise<T> {
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body }),
  })
  expect(response.status, await response.clone().text()).toBe(options.expectedStatus ?? 200)
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

async function nextSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 5_000)
    socket.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()) as Record<string, unknown>)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
