import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const baseUrl = process.env.INTEGRATION_BASE_URL
const integration = baseUrl === undefined ? describe.skip : describe

integration('NoteGen two-device client behavior', () => {
  it('preserves local-only configuration and converges after offline edits and a conflict', async () => {
    if (baseUrl === undefined) throw new Error('INTEGRATION_BASE_URL is required')

    const capabilitiesA = await api<{ instanceId: string, protocol: { minimum: number, maximum: number } }>(
      baseUrl, '/v1/capabilities',
    )
    const capabilitiesB = await api<{ instanceId: string }>(baseUrl, '/v1/capabilities')
    expect(capabilitiesB.instanceId).toBe(capabilitiesA.instanceId)
    expect(capabilitiesA.protocol.minimum).toBeLessThanOrEqual(capabilitiesA.protocol.maximum)

    const login = `client-behavior-${randomUUID()}@example.test`
    const password = 'integration-password'
    const deviceA = await NoteGenClient.register(baseUrl, login, password, 'Desktop A')
    const workspace = await deviceA.createWorkspace()
    const deviceB = await NoteGenClient.login(baseUrl, login, password, 'Desktop B')
    deviceA.workspaceId = workspace.id
    deviceB.workspaceId = workspace.id

    const noteId = randomUUID()
    deviceA.edit(noteId, 'note', '# Local-first note', null)
    deviceA.updateConfiguration({
      'editor.fontSize': 16,
      'sync.baseUrl': 'https://must-stay-local.invalid',
      'sync.refreshToken': 'must-never-leave-device',
      'system.downloadDirectory': '/private/local/path',
    })
    expect(deviceA.pendingKinds()).toEqual(['note', 'setting'])
    await deviceA.flush()

    await deviceB.bootstrap()
    expect(deviceB.read(noteId)).toBe('# Local-first note')
    expect(deviceB.read(settingObjectId('editor.fontSize'))).toContain('editor.fontSize')
    expect([...deviceB.objects.values()].some((object) => object.plaintext.includes('must-stay-local'))).toBe(false)
    expect([...deviceB.objects.values()].some((object) => object.plaintext.includes('must-never-leave'))).toBe(false)

    // Both clients edit revision 1 while disconnected. A wins the server race;
    // B keeps its text as a visible conflict copy instead of silently overwriting.
    deviceA.edit(noteId, 'note', '# Edited offline on A', '1')
    deviceB.edit(noteId, 'note', '# Edited offline on B', '1')
    await deviceA.flush()
    const conflicts = await deviceB.flush()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.current?.currentRevision).toBe('2')

    const conflictCopyId = randomUUID()
    deviceB.edit(conflictCopyId, 'note', '# Edited offline on B\n\n> Conflict copy', null)
    await deviceB.pull()
    await deviceB.flush()
    await deviceA.pull()

    expect(deviceA.read(noteId)).toBe('# Edited offline on A')
    expect(deviceA.read(conflictCopyId)).toContain('Conflict copy')
    expect(deviceA.cursor).toBe(deviceB.cursor)
    expect(deviceA.outbox).toHaveLength(0)
    expect(deviceB.outbox).toHaveLength(0)

    // Simulate a lost Push response. Retrying the durable outbox operation must
    // produce the same revision and must not create a second change.
    const retryId = randomUUID()
    const retryOperation = operation(retryId, randomUUID(), 'note', 'retry exactly once', null)
    const first = await deviceA.pushRaw(retryOperation)
    const retried = await deviceA.pushRaw(retryOperation)
    if (first.status !== 'applied' || retried.status !== 'applied') {
      throw new Error('Idempotent retry did not apply')
    }
    expect(first).toMatchObject({ status: 'applied', duplicate: false })
    expect(retried).toMatchObject({
      status: 'applied', duplicate: true, revision: first.revision, sequence: first.sequence,
    })
  }, 30_000)
})

const synchronizedSettings = new Set(['editor.fontSize', 'editor.theme', 'editor.language'])

class NoteGenClient {
  workspaceId = ''
  cursor = '0'
  readonly objects = new Map<string, LocalObject>()
  readonly outbox: Operation[] = []

  private constructor(
    readonly origin: string,
    readonly authorization: Record<string, string>,
  ) {}

  static async register(origin: string, login: string, password: string, deviceName: string) {
    const session = await api<Session>(origin, '/v1/auth/register', {
      method: 'POST',
      headers: { 'x-setup-token': process.env.INTEGRATION_SETUP_TOKEN ?? 'integration-setup-token' },
      expectedStatus: 201,
      body: { login, password, deviceId: randomUUID(), deviceName, platform: 'test' },
    })
    return new NoteGenClient(origin, { authorization: `Bearer ${session.accessToken}` })
  }

  static async login(origin: string, login: string, password: string, deviceName: string) {
    const session = await api<Session>(origin, '/v1/auth/login', {
      method: 'POST',
      body: { login, password, deviceId: randomUUID(), deviceName, platform: 'test' },
    })
    return new NoteGenClient(origin, { authorization: `Bearer ${session.accessToken}` })
  }

  async createWorkspace(): Promise<{ id: string }> {
    return api(this.origin, '/v1/workspaces', {
      method: 'POST', headers: this.authorization, expectedStatus: 201,
      body: {
        nameCiphertext: 'encrypted-client-behavior-workspace',
        keyVersion: 1,
        envelopes: [
          {
            type: 'passphrase', recipientId: null, wrappedKey: 'passphrase-envelope',
            kdfSalt: 'salt', kdfParams: { memory: 65536, iterations: 3 },
          },
          {
            type: 'recovery', recipientId: null, wrappedKey: 'recovery-envelope',
            kdfSalt: null, kdfParams: null,
          },
        ],
      },
    })
  }

  updateConfiguration(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      if (!synchronizedSettings.has(key)) continue
      this.edit(settingObjectId(key), 'setting', JSON.stringify({ schemaVersion: 1, key, value }), null)
    }
  }

  edit(objectId: string, kind: ObjectKind, plaintext: string, baseRevision: string | null): void {
    this.outbox.push(operation(randomUUID(), objectId, kind, plaintext, baseRevision))
  }

  pendingKinds(): ObjectKind[] {
    return this.outbox.map((item) => item.kind)
  }

  read(objectId: string): string | undefined {
    return this.objects.get(objectId)?.plaintext
  }

  async flush(): Promise<ConflictResult[]> {
    const conflicts: ConflictResult[] = []
    while (this.outbox.length > 0) {
      const pending = this.outbox[0]
      if (pending === undefined) break
      const result = await this.pushRaw(pending)
      this.outbox.shift()
      if (result.status === 'conflict') conflicts.push(result)
    }
    await this.pull()
    return conflicts
  }

  async pushRaw(input: Operation): Promise<PushResult> {
    const response = await api<{ results: PushResult[] }>(
      this.origin, `/v1/workspaces/${this.workspaceId}/sync/push`, {
        method: 'POST', headers: this.authorization, body: { operations: [input] },
      },
    )
    const result = response.results[0]
    if (result === undefined) throw new Error('Push returned no result')
    return result
  }

  async bootstrap(): Promise<void> {
    const response = await api<{
      objects: RemoteObject[]
      snapshotSequence: string
      hasMore: boolean
    }>(this.origin, `/v1/workspaces/${this.workspaceId}/sync/bootstrap`, { headers: this.authorization })
    expect(response.hasMore).toBe(false)
    this.objects.clear()
    for (const object of response.objects) this.apply(object)
    this.cursor = response.snapshotSequence
  }

  async pull(): Promise<void> {
    for (;;) {
      const response = await api<{
        changes: Array<RemoteObject & { sequence: string }>
        nextCursor: string
        hasMore: boolean
      }>(this.origin, `/v1/workspaces/${this.workspaceId}/sync/changes?after=${this.cursor}`, {
        headers: this.authorization,
      })
      for (const change of response.changes) this.apply(change)
      this.cursor = response.nextCursor
      if (!response.hasMore) return
    }
  }

  private apply(object: RemoteObject): void {
    const revision = object.currentRevision ?? object.revision
    if (revision === undefined) throw new Error('Remote object has no revision')
    this.objects.set(object.objectId, {
      revision,
      plaintext: Buffer.from(object.ciphertext, 'base64url').toString(),
    })
  }
}

type ObjectKind = 'note' | 'setting'

interface Session { accessToken: string }
interface LocalObject { revision: string, plaintext: string }
interface RemoteObject {
  objectId: string
  revision?: string
  currentRevision?: string
  ciphertext: string
}
interface Operation {
  operationId: string
  objectId: string
  kind: ObjectKind
  baseRevision: string | null
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
  blobRefs: string[]
  delete: boolean
}
interface AppliedResult {
  status: 'applied'
  revision: string
  sequence: string
  duplicate: boolean
}
interface ConflictResult {
  status: 'conflict'
  current: { currentRevision: string } | null
}
interface RejectedResult { status: 'rejected', code: string }
type PushResult = AppliedResult | ConflictResult | RejectedResult

function operation(
  operationId: string,
  objectId: string,
  kind: ObjectKind,
  plaintext: string,
  baseRevision: string | null,
): Operation {
  const bytes = Buffer.from(plaintext)
  return {
    operationId,
    objectId,
    kind,
    baseRevision,
    keyVersion: 1,
    ciphertext: bytes.toString('base64url'),
    ciphertextHash: createHash('sha256').update(bytes).digest('base64url'),
    blobRefs: [],
    delete: false,
  }
}

function settingObjectId(key: string): string {
  const hex = createHash('sha256').update(`notegen-setting:${key}`).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
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
  return await response.json() as T
}
