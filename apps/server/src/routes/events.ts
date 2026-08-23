import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { RawData, WebSocket } from 'ws'
import type { TokenService } from '../auth/tokens.js'
import type { AuthService } from '../auth/service.js'
import type { ChangeNotifier } from '../sync/types.js'
import type { WorkspaceService } from '../workspaces/service.js'

interface AuthenticateMessage {
  type: 'authenticate'
  accessToken: string
  workspaceIds: string[]
  expectedSyncEpoch: string
}

interface PresenceUpdateMessage {
  type: 'presence.update'
  workspaceId: string
  documentId: string
  anchor: number
  head: number
  label: string
  coordinateSpace: 'markdown' | 'prosemirror' | 'canvas'
  canvas: {
    nodes: Array<{ id: string; x: number; y: number }>
  } | null
}

interface PresenceClearMessage {
  type: 'presence.clear'
}

interface DocumentSubscriptionMessage {
  type: 'document.subscribe' | 'document.unsubscribe'
  workspaceId: string
  documentId: string
}

type RealtimeMessage = PresenceUpdateMessage | PresenceClearMessage
  | DocumentSubscriptionMessage
type PresenceMessage = PresenceUpdateMessage | PresenceClearMessage

interface PresenceState extends PresenceUpdateMessage {
  deviceId: string
}

interface PresenceConnection {
  socket: WebSocket
  deviceId: string
  workspaceIds: Set<string>
  documentIds: Set<string>
  presence: PresenceState | null
  accountId: string
  credentialEpoch: string
  instanceAuthEpoch?: string
  issuedAt?: number
  rateTokens: number
  rateUpdatedAt: number
}

const REALTIME_BURST_BYTES = 4 * 1024 * 1024
const REALTIME_BYTES_PER_SECOND = 1024 * 1024
const MAX_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024

export function createEventRoutes(
  tokens: TokenService,
  auth: AuthService,
  workspaces: WorkspaceService,
  notifier: ChangeNotifier,
  syncEpoch?: string,
): FastifyPluginAsyncTypebox {
  const presenceRooms = new Map<string, Set<PresenceConnection>>()
  return async function eventRoutes(app) {
    app.get('/v1/sync/events', {
      websocket: true,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    }, (socket) => {
      let authenticated = false
      let alive = true
      const unsubscribe: Array<() => void> = []
      let sessionTimeout: NodeJS.Timeout | undefined
      let presenceConnection: PresenceConnection | null = null
      const authTimeout = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5_000)
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate()
          return
        }
        alive = false
        socket.ping()
      }, 30_000)

      socket.on('pong', () => { alive = true })
      socket.on('close', () => cleanup())
      socket.on('error', () => cleanup())
      socket.on('message', (raw) => void handleMessage(raw, socket))

      const cleanup = (): void => {
        clearTimeout(authTimeout)
        clearInterval(heartbeat)
        if (sessionTimeout !== undefined) clearTimeout(sessionTimeout)
        for (const stop of unsubscribe.splice(0)) stop()
        if (presenceConnection) {
          clearPresence(presenceConnection, presenceRooms)
          for (const workspaceId of presenceConnection.workspaceIds) {
            const room = presenceRooms.get(workspaceId)
            room?.delete(presenceConnection)
            if (room?.size === 0) presenceRooms.delete(workspaceId)
          }
          presenceConnection = null
        }
      }

      const handleMessage = async (raw: RawData, currentSocket: WebSocket): Promise<void> => {
        if (authenticated) {
          if (!presenceConnection) return
          try {
            consumeRealtimeBudget(presenceConnection, Buffer.byteLength(raw.toString()))
            const message = parseRealtimeMessage(raw)
            if (message.type === 'document.subscribe'
              || message.type === 'document.unsubscribe') {
              handleDocumentSubscription(message, presenceConnection, presenceRooms)
            } else if (message.type === 'presence.update' || message.type === 'presence.clear') {
              handlePresenceMessage(message, presenceConnection, presenceRooms)
            }
          } catch {
            currentSocket.close(1008, 'Invalid realtime message')
          }
          return
        }
        try {
          const message = parseAuthenticateMessage(raw)
          if (syncEpoch !== undefined && message.expectedSyncEpoch !== syncEpoch) {
            sendWithBackpressure(currentSocket, JSON.stringify({ type: 'sync.epoch-changed', code: 'sync_epoch_changed', retryable: false }))
            currentSocket.close(1008, 'Sync epoch changed')
            return
          }
          const claims = await tokens.verifyAccessToken(message.accessToken)
          await auth.assertDeviceActive(claims.accountId, claims.deviceId, claims.credentialEpoch, claims.instanceAuthEpoch, claims.issuedAt)
          const uniqueWorkspaceIds = [...new Set(message.workspaceIds)]
          if (uniqueWorkspaceIds.length > 100) throw new Error('Too many workspace subscriptions')
          await Promise.all(uniqueWorkspaceIds.map((id) => (
            workspaces.assertCapability(claims.accountId, id, 'content.read')
          )))
          unsubscribe.push(notifier.subscribeAccount(claims.accountId, () => {
            if (currentSocket.readyState === currentSocket.OPEN) {
              sendWithBackpressure(currentSocket, JSON.stringify({ type: 'account.workspaces-changed' }))
            }
          }))
          for (const workspaceId of uniqueWorkspaceIds) {
            unsubscribe.push(notifier.subscribeWorkspace(workspaceId, (notice) => {
              if (currentSocket.readyState === currentSocket.OPEN) sendWithBackpressure(currentSocket, JSON.stringify(notice))
              if (notice.type === 'workspace.members-changed') {
                void workspaces.assertCapability(claims.accountId, workspaceId, 'content.read').catch(() => {
                  if (currentSocket.readyState === currentSocket.OPEN) {
                    sendWithBackpressure(currentSocket, JSON.stringify({
                      type: 'workspace.access-revoked', workspaceId,
                    }))
                    currentSocket.close(1008, 'Workspace access revoked')
                  }
                })
              }
            }))
          }
          authenticated = true
          const connection: PresenceConnection = {
            socket: currentSocket,
            deviceId: claims.deviceId,
            workspaceIds: new Set(uniqueWorkspaceIds),
            documentIds: new Set(),
            presence: null,
            accountId: claims.accountId,
            credentialEpoch: claims.credentialEpoch,
            ...(claims.instanceAuthEpoch === undefined ? {} : { instanceAuthEpoch: claims.instanceAuthEpoch }),
            ...(claims.issuedAt === undefined ? {} : { issuedAt: claims.issuedAt }),
            rateTokens: REALTIME_BURST_BYTES,
            rateUpdatedAt: Date.now(),
          }
          presenceConnection = connection
          for (const workspaceId of uniqueWorkspaceIds) {
            const room = presenceRooms.get(workspaceId) ?? new Set<PresenceConnection>()
            room.add(connection)
            presenceRooms.set(workspaceId, room)
          }
          clearTimeout(authTimeout)
          sessionTimeout = setTimeout(() => {
            currentSocket.close(1008, 'Access token expired')
          }, Math.max(1, claims.expiresAt * 1_000 - Date.now()))
          sendWithBackpressure(currentSocket, JSON.stringify({
            type: 'authenticated',
            workspaceIds: uniqueWorkspaceIds,
            accessTokenExpiresAt: new Date(claims.expiresAt * 1_000).toISOString(),
          }))
        } catch {
          currentSocket.close(1008, 'Authentication failed')
        }
      }
    })
  }
}

function parseAuthenticateMessage(raw: RawData): AuthenticateMessage {
  const value: unknown = JSON.parse(raw.toString())
  if (typeof value !== 'object' || value === null) throw new Error('Message must be an object')
  const candidate = value as Record<string, unknown>
  if (candidate.type !== 'authenticate' || typeof candidate.accessToken !== 'string'
    || !Array.isArray(candidate.workspaceIds)
    || !candidate.workspaceIds.every((id) => typeof id === 'string')
    || typeof candidate.expectedSyncEpoch !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.expectedSyncEpoch)) {
    throw new Error('Authentication message is invalid')
  }
  return {
    type: 'authenticate',
    accessToken: candidate.accessToken,
    workspaceIds: candidate.workspaceIds,
    expectedSyncEpoch: candidate.expectedSyncEpoch,
  }
}

function parseRealtimeMessage(raw: RawData): RealtimeMessage {
  const value: unknown = JSON.parse(raw.toString())
  if (typeof value !== 'object' || value === null) throw new Error('Message must be an object')
  const candidate = value as Record<string, unknown>
  if (candidate.type === 'presence.clear') return { type: 'presence.clear' }
  if (candidate.type === 'document.subscribe' || candidate.type === 'document.unsubscribe') {
    if (typeof candidate.workspaceId !== 'string' || typeof candidate.documentId !== 'string') {
      throw new Error('Document subscription message is invalid')
    }
    return {
      type: candidate.type,
      workspaceId: candidate.workspaceId,
      documentId: candidate.documentId.slice(0, 200),
    }
  }
  if (candidate.type !== 'presence.update'
    || typeof candidate.workspaceId !== 'string'
    || typeof candidate.documentId !== 'string'
    || typeof candidate.anchor !== 'number' || !Number.isSafeInteger(candidate.anchor)
    || typeof candidate.head !== 'number' || !Number.isSafeInteger(candidate.head)
    || candidate.anchor < 0 || candidate.head < 0
    || typeof candidate.label !== 'string') {
    throw new Error('Presence message is invalid')
  }
  return {
    type: 'presence.update',
    workspaceId: candidate.workspaceId,
    documentId: candidate.documentId.slice(0, 200),
    anchor: candidate.anchor,
    head: candidate.head,
    label: candidate.label.trim().slice(0, 40) || '其他设备',
    coordinateSpace: parsePresenceCoordinateSpace(candidate.coordinateSpace, candidate.canvas),
    canvas: parseCanvasPresence(candidate.canvas),
  }
}

function parsePresenceCoordinateSpace(
  value: unknown,
  canvas: unknown,
): PresenceUpdateMessage['coordinateSpace'] {
  if (value === 'markdown' || value === 'prosemirror' || value === 'canvas') return value
  return canvas === undefined || canvas === null ? 'prosemirror' : 'canvas'
}

function parseCanvasPresence(value: unknown): PresenceUpdateMessage['canvas'] {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || value === null) throw new Error('Canvas presence is invalid')
  const nodes = (value as Record<string, unknown>).nodes
  if (!Array.isArray(nodes) || nodes.length > 100) throw new Error('Canvas presence is invalid')
  return {
    nodes: nodes.map((node) => {
      if (typeof node !== 'object' || node === null) throw new Error('Canvas presence node is invalid')
      const candidate = node as Record<string, unknown>
      if (typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 200
        || typeof candidate.x !== 'number' || !Number.isFinite(candidate.x)
        || typeof candidate.y !== 'number' || !Number.isFinite(candidate.y)) {
        throw new Error('Canvas presence node is invalid')
      }
      return { id: candidate.id, x: candidate.x, y: candidate.y }
    }),
  }
}

function handleDocumentSubscription(
  message: DocumentSubscriptionMessage,
  connection: PresenceConnection,
  rooms: Map<string, Set<PresenceConnection>>,
): void {
  if (!connection.workspaceIds.has(message.workspaceId)) throw new Error('Workspace is not subscribed')
  const key = `${message.workspaceId}\0${message.documentId}`
  if (message.type === 'document.unsubscribe') {
    connection.documentIds.delete(key)
    return
  }
  if (connection.documentIds.has(key)) return
  connection.documentIds.add(key)
  const payload = JSON.stringify({
    type: 'document.sync-request',
    workspaceId: message.workspaceId,
    documentId: message.documentId,
    deviceId: connection.deviceId,
  })
  for (const peer of rooms.get(message.workspaceId) ?? []) {
    if (peer !== connection && peer.documentIds.has(key)
      && peer.socket.readyState === peer.socket.OPEN) {
      sendWithBackpressure(peer.socket, payload)
    }
  }
}

function consumeRealtimeBudget(connection: PresenceConnection, bytes: number): void {
  const now = Date.now()
  const replenished = Math.min(
    REALTIME_BURST_BYTES,
    connection.rateTokens + ((now - connection.rateUpdatedAt) / 1_000) * REALTIME_BYTES_PER_SECOND,
  )
  connection.rateUpdatedAt = now
  connection.rateTokens = replenished - bytes
  if (connection.rateTokens < 0) throw new Error('Realtime rate limit exceeded')
}

function sendWithBackpressure(socket: WebSocket, payload: string): void {
  if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
    socket.close(1013, 'Realtime consumer is too slow')
    return
  }
  socket.send(payload)
}

function handlePresenceMessage(
  message: PresenceMessage,
  connection: PresenceConnection,
  rooms: Map<string, Set<PresenceConnection>>,
): void {
  if (message.type === 'presence.clear') {
    clearPresence(connection, rooms)
    return
  }
  if (!connection.workspaceIds.has(message.workspaceId)) throw new Error('Workspace is not subscribed')
  const enteringDocument = !connection.presence
    || connection.presence.workspaceId !== message.workspaceId
    || connection.presence.documentId !== message.documentId
  if (connection.presence
    && (connection.presence.workspaceId !== message.workspaceId
      || connection.presence.documentId !== message.documentId)) {
    clearPresence(connection, rooms)
  }
  const room = rooms.get(message.workspaceId)
  if (!room) return
  if (enteringDocument) {
    for (const peer of room) {
      const peerPresence = peer.presence
      if (peer !== connection && peerPresence?.documentId === message.documentId) {
        sendPresence(peerPresence, connection.socket)
      }
    }
  }
  connection.presence = { ...message, deviceId: connection.deviceId }
  for (const peer of room) {
    if (peer !== connection) sendPresence(connection.presence, peer.socket)
  }
}

function clearPresence(
  connection: PresenceConnection,
  rooms: Map<string, Set<PresenceConnection>>,
): void {
  const previous = connection.presence
  if (!previous) return
  connection.presence = null
  const room = rooms.get(previous.workspaceId)
  if (!room) return
  const payload = JSON.stringify({
    type: 'presence.cleared',
    workspaceId: previous.workspaceId,
    documentId: previous.documentId,
    deviceId: connection.deviceId,
  })
  for (const peer of room) {
    if (peer !== connection && peer.socket.readyState === peer.socket.OPEN) sendWithBackpressure(peer.socket, payload)
  }
}

function sendPresence(presence: PresenceState, socket: WebSocket): void {
  if (socket.readyState !== socket.OPEN) return
  sendWithBackpressure(socket, JSON.stringify({
    type: 'presence.updated',
    workspaceId: presence.workspaceId,
    documentId: presence.documentId,
    deviceId: presence.deviceId,
    label: presence.label,
    anchor: presence.anchor,
    head: presence.head,
    coordinateSpace: presence.coordinateSpace,
    canvas: presence.canvas,
  }))
}
