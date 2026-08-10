import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const baseUrl = normalizeOrigin(process.env.SELF_TEST_BASE_URL ?? 'http://127.0.0.1:3789')
const setupToken = process.env.SELF_TEST_SETUP_TOKEN
const keepData = process.env.SELF_TEST_KEEP_DATA === 'true'
const password = 'notegen-self-test-password'

await main().catch((error: unknown) => {
  console.error('\n❌ NoteGen Sync Server 自测失败')
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

async function main(): Promise<void> {
  console.log(`NoteGen Sync Server 个人验收：${baseUrl}`)

  const ready = await request<{ status: string }>('/health/ready')
  assert(ready.status === 'ok', '服务端尚未 ready')
  const capabilities = await request<Capabilities>('/v1/capabilities')
  assert(capabilities.service === 'note-gen-server', '目标地址不是 NoteGen Sync Server')
  assert(capabilities.protocol.minimum <= 1 && capabilities.protocol.maximum >= 1, '服务端不支持协议 v1')
  console.log(`✓ 服务可用：${capabilities.serverName} ${capabilities.serverVersion}`)
  console.log(`✓ 实例身份：${capabilities.instanceId}`)

  const login = `self-test-${randomUUID()}@example.test`
  const deviceAId = randomUUID()
  const deviceBId = randomUUID()
  const deviceA = await request<Session>('/v1/auth/register', {
    method: 'POST',
    expectedStatus: 201,
    ...(setupToken === undefined ? {} : { headers: { 'x-setup-token': setupToken } }),
    body: {
      login,
      password,
      deviceId: deviceAId,
      deviceName: 'Self Test Device A',
      platform: 'self-test',
    },
  })
  const authA = { authorization: `Bearer ${deviceA.accessToken}` }
  const deviceB = await request<Session>('/v1/auth/login', {
    method: 'POST',
    body: {
      login,
      password,
      deviceId: deviceBId,
      deviceName: 'Self Test Device B',
      platform: 'self-test',
    },
  })
  const authB = { authorization: `Bearer ${deviceB.accessToken}` }
  console.log('✓ 注册账号并登录第二台设备')

  const workspace = await request<{ id: string }>('/v1/workspaces', {
    method: 'POST',
    expectedStatus: 201,
    headers: authA,
    body: {
      nameCiphertext: 'self-test-encrypted-workspace-name',
      keyVersion: 1,
      envelopes: [
        {
          type: 'passphrase',
          recipientId: null,
          wrappedKey: 'self-test-passphrase-envelope',
          kdfSalt: 'self-test-salt',
          kdfParams: { memory: 65536, iterations: 3 },
        },
        {
          type: 'recovery',
          recipientId: null,
          wrappedKey: 'self-test-recovery-envelope',
          kdfSalt: null,
          kdfParams: null,
        },
      ],
    },
  })
  console.log(`✓ 创建 Workspace：${workspace.id}`)

  const noteId = randomUUID()
  const firstCommand = makeCommand(randomUUID(), noteId, 'note', '# NoteGen self test', null)
  const first = await push(workspace.id, authA, firstCommand)
  assert(first.status === 'applied' && first.revision === '1' && first.duplicate === false, '首次 Push 结果不正确')

  const duplicate = await push(workspace.id, authA, firstCommand)
  assert(duplicate.status === 'applied' && duplicate.revision === '1' && duplicate.duplicate === true,
    '同一 operationId 没有被幂等处理')
  console.log('✓ 首次 Push 与响应丢失后的幂等重试')

  const bootstrap = await request<Bootstrap>(`/v1/workspaces/${workspace.id}/sync/bootstrap`, { headers: authB })
  assert(bootstrap.objects.some((item) => item.objectId === noteId && item.currentRevision === '1'),
    '第二台设备 Bootstrap 后没有收到笔记')
  console.log('✓ 第二台设备 Bootstrap 获得完整快照')

  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/v1/sync/events`)
  await socketOpened(socket)
  socket.send(JSON.stringify({
    type: 'authenticate',
    accessToken: deviceB.accessToken,
    workspaceIds: [workspace.id],
  }))
  const authenticated = await nextSocketMessage(socket)
  assert(authenticated.type === 'authenticated', 'WebSocket 认证失败')

  const changedNotice = nextSocketMessage(socket)
  const secondCommand = makeCommand(randomUUID(), noteId, 'note', '# Edited offline on device A', '1')
  const second = await push(workspace.id, authA, secondCommand)
  assert(second.status === 'applied' && second.revision === '2', '第二版笔记 Push 失败')
  const notice = await changedNotice
  assert(notice.type === 'workspace.changed' && notice.workspaceId === workspace.id, '没有收到实时变更通知')
  socket.close()
  console.log('✓ WebSocket 实时唤醒')

  const staleCommand = makeCommand(randomUUID(), noteId, 'note', '# Edited offline on device B', '1')
  const conflict = await push(workspace.id, authB, staleCommand)
  assert(conflict.status === 'conflict' && conflict.revision === '2',
    '过期 revision 没有产生可处理的冲突')
  console.log('✓ 双设备离线编辑不会静默覆盖')

  const settingId = deterministicSettingId('editor.fontSize')
  const setting = makeCommand(
    randomUUID(),
    settingId,
    'setting',
    JSON.stringify({ schemaVersion: 1, key: 'editor.fontSize', value: 16 }),
    null,
  )
  const settingResult = await push(workspace.id, authB, setting)
  assert(settingResult.status === 'applied', '允许同步的编辑器设置 Push 失败')

  const pulled = await request<Pull>(`/v1/workspaces/${workspace.id}/sync/events?after=0`, { headers: authA })
  assert(pulled.events.some((item) => item.objectId === noteId && item.metadata.revision === '2'), '设备 A 未拉取到最新笔记')
  assert(pulled.events.some((item) => item.objectId === settingId && item.metadata.kind === 'setting'), '设备 A 未拉取到同步设置')
  console.log(`✓ 增量 Pull 收敛到 cursor ${pulled.nextCursor}`)
  console.log('✓ 配置对象同步；SyncProfile、Token 和本地路径未进入测试载荷')

  if (keepData) {
    console.log('\n✅ 全部验收通过，测试数据已保留')
    console.log(`测试账号：${login}`)
    console.log(`测试密码：${password}`)
    return
  }

  await request('/v1/account', {
    method: 'DELETE',
    expectedStatus: 202,
    headers: authA,
    body: { password, confirmation: 'DELETE' },
  })
  console.log('✓ 测试账号已停用，并进入服务端保留期清理队列')
  console.log('\n✅ 全部验收通过')
}

async function push(workspaceId: string, headers: Record<string, string>, command: SyncCommand): Promise<PushResult> {
  const response = await request<{ results: PushResult[] }>(`/v1/workspaces/${workspaceId}/sync/commands`, {
    method: 'POST',
    headers,
    body: { commands: [command] },
  })
  const result = response.results[0]
  if (result === undefined) throw new Error('Push 未返回结果')
  return result
}

function makeCommand(
  commandId: string,
  objectId: string,
  kind: 'note' | 'setting',
  plaintext: string,
  baseRevision: string | null,
): SyncCommand {
  // 服务端只处理 opaque ciphertext。这里使用协议形状正确的模拟密文，
  // 真正的 AEAD 加解密由 NoteGen 客户端负责并单独测试。
  const encryptedBytes = Buffer.from(plaintext)
  return {
    type: 'upsert-object',
    commandId,
    objectId,
    kind,
    baseRevision,
    keyVersion: 1,
    ciphertext: encryptedBytes.toString('base64url'),
    ciphertextHash: createHash('sha256').update(encryptedBytes).digest('base64url'),
    blobRefs: [],
    parentObjectId: null,
    nameCiphertext: encryptedBytes.toString('base64url'),
  }
}

async function request<T = unknown>(
  path: string,
  options: {
    method?: string
    expectedStatus?: number
    headers?: Record<string, string>
    body?: unknown
  } = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  if (response.status !== (options.expectedStatus ?? 200)) {
    let hint = ''
    try {
      const error = JSON.parse(text) as { code?: string }
      if (error.code === 'registration_closed' && setupToken === undefined) {
        hint = '\n请设置 SELF_TEST_SETUP_TOKEN；它应与服务端 SETUP_TOKEN 一致。'
      }
    } catch {
      // Preserve the raw response below.
    }
    throw new Error(`${options.method ?? 'GET'} ${path} 返回 ${response.status}: ${text}${hint}`)
  }
  if (response.status === 204 || text.length === 0) return undefined as T
  return JSON.parse(text) as T
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('SELF_TEST_BASE_URL 必须使用 HTTP(S)')
  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('SELF_TEST_BASE_URL 必须是没有路径、查询参数和片段的 origin')
  }
  return parsed.origin
}

function deterministicSettingId(key: string): string {
  const digits = createHash('sha256').update(`notegen-setting:${key}`).digest('hex').slice(0, 32).split('')
  digits[12] = '5'
  digits[16] = ((Number.parseInt(digits[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const value = digits.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function socketOpened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', reject)
  })
}

function nextSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 WebSocket 消息超时')), 5_000)
    socket.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()) as Record<string, unknown>)
    })
    socket.once('error', reject)
  })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

interface Capabilities {
  service: string
  instanceId: string
  serverName: string
  serverVersion: string
  protocol: { minimum: number, maximum: number }
}

interface Session { accessToken: string }
interface SyncCommand {
  type: 'upsert-object'
  commandId: string
  objectId: string
  kind: 'note' | 'setting'
  baseRevision: string | null
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
  blobRefs: string[]
  parentObjectId: null
  nameCiphertext: string
}
type PushResult =
  | { status: 'applied', revision: string, sequence: string, duplicate: boolean }
  | { status: 'conflict', revision?: string }
  | { status: 'rejected', code: string, retryable: boolean }
interface Bootstrap {
  objects: Array<{ objectId: string, currentRevision: string }>
}
interface Pull {
  events: Array<{ objectId: string | null, metadata: { revision?: string, kind?: string } }>
  nextCursor: string
}
