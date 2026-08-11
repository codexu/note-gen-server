import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { RawData, WebSocket } from 'ws'
import type { TokenService } from '../auth/tokens.js'
import type { AuthService } from '../auth/service.js'
import type { ChangeNotifier } from '../sync/types.js'
import type { WorkspaceService } from '../workspaces/service.js'
import type { MaintenanceCoordinator } from '../maintenance/coordinator.js'
import { ApiError } from '../errors.js'

interface AuthenticateMessage {
  type: 'authenticate'
  accessToken: string
  workspaceIds: string[]
  expectedSyncEpoch?: string
}

interface PresenceUpdateMessage {
  type: 'presence.update'
  workspaceId: string
  documentId: string
  anchor: number
  head: number
  label: string
}

interface PresenceClearMessage {
  type: 'presence.clear'
}

interface DocumentUpdateMessage {
  type: 'document.update'
  workspaceId: string
  documentId: string
  objectId: string
  kind: string
  updateId: string
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
}

interface DocumentSubscriptionMessage {
  type: 'document.subscribe' | 'document.unsubscribe'
  workspaceId: string
  documentId: string
}

type RealtimeMessage = PresenceUpdateMessage | PresenceClearMessage
  | DocumentUpdateMessage | DocumentSubscriptionMessage

interface PresenceState extends PresenceUpdateMessage {
  deviceId: string
}

interface PresenceConnection {
  socket: WebSocket
  deviceId: string
  workspaceIds: Set<string>
  documentIds: Set<string>
  presence: PresenceState | null
}

export function createEventRoutes(
  tokens: TokenService,
  auth: AuthService,
  workspaces: WorkspaceService,
  notifier: ChangeNotifier,
  maintenance?: MaintenanceCoordinator,
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
            const message = parseRealtimeMessage(raw)
            if (message.type === 'document.update') {
              await assertRealtimeMutationAllowed(maintenance, currentSocket)
              relayDocumentUpdate(message, presenceConnection, presenceRooms)
            } else if (message.type === 'document.subscribe'
              || message.type === 'document.unsubscribe') {
              handleDocumentSubscription(message, presenceConnection, presenceRooms)
            } else {
              handlePresenceMessage(message, presenceConnection, presenceRooms)
            }
          } catch (error) {
            if (error instanceof ApiError && error.code === 'server_maintenance') return
            currentSocket.close(1008, 'Invalid realtime message')
          }
          return
        }
        try {
          const message = parseAuthenticateMessage(raw)
          if (message.expectedSyncEpoch !== undefined && syncEpoch !== undefined && message.expectedSyncEpoch !== syncEpoch) {
            currentSocket.send(JSON.stringify({ type: 'sync.epoch-changed', code: 'sync_epoch_changed', retryable: false }))
            currentSocket.close(1008, 'Sync epoch changed')
            return
          }
          const claims = await tokens.verifyAccessToken(message.accessToken)
          await auth.assertDeviceActive(claims.accountId, claims.deviceId, claims.credentialEpoch, claims.instanceAuthEpoch, claims.issuedAt)
          const uniqueWorkspaceIds = [...new Set(message.workspaceIds)]
          if (uniqueWorkspaceIds.length > 100) throw new Error('Too many workspace subscriptions')
          await Promise.all(uniqueWorkspaceIds.map((id) => workspaces.assertOwned(claims.accountId, id)))
          unsubscribe.push(notifier.subscribeAccount(claims.accountId, () => {
            if (currentSocket.readyState === currentSocket.OPEN) {
              currentSocket.send(JSON.stringify({ type: 'account.workspaces-changed' }))
            }
          }))
          for (const workspaceId of uniqueWorkspaceIds) {
            unsubscribe.push(notifier.subscribeWorkspace(workspaceId, (notice) => {
              if (currentSocket.readyState === currentSocket.OPEN) currentSocket.send(JSON.stringify(notice))
            }))
          }
          authenticated = true
          presenceConnection = {
            socket: currentSocket,
            deviceId: claims.deviceId,
            workspaceIds: new Set(uniqueWorkspaceIds),
            documentIds: new Set(),
            presence: null,
          }
          for (const workspaceId of uniqueWorkspaceIds) {
            const room = presenceRooms.get(workspaceId) ?? new Set<PresenceConnection>()
            room.add(presenceConnection)
            presenceRooms.set(workspaceId, room)
          }
          clearTimeout(authTimeout)
          sessionTimeout = setTimeout(() => {
            currentSocket.close(1008, 'Access token expired')
          }, Math.max(1, claims.expiresAt * 1_000 - Date.now()))
          currentSocket.send(JSON.stringify({
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

async function assertRealtimeMutationAllowed(maintenance: MaintenanceCoordinator | undefined, socket: WebSocket): Promise<void> {
  if (maintenance === undefined) return
  try {
    await maintenance.requireMutationAllowed('/v1/sync/events')
  } catch (error) {
    if (error instanceof ApiError && error.code === 'server_maintenance') {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({
        type: 'server.maintenance', code: error.code, retryable: error.retryable, details: error.details,
      }))
      socket.close(1013, 'Server maintenance')
    }
    throw error
  }
}

function parseAuthenticateMessage(raw: RawData): AuthenticateMessage {
  const value: unknown = JSON.parse(raw.toString())
  if (typeof value !== 'object' || value === null) throw new Error('Message must be an object')
  const candidate = value as Record<string, unknown>
  if (candidate.type !== 'authenticate' || typeof candidate.accessToken !== 'string'
    || !Array.isArray(candidate.workspaceIds)
    || !candidate.workspaceIds.every((id) => typeof id === 'string')
    || (candidate.expectedSyncEpoch !== undefined
      && (typeof candidate.expectedSyncEpoch !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.expectedSyncEpoch)))) {
    throw new Error('Authentication message is invalid')
  }
  return {
    type: 'authenticate',
    accessToken: candidate.accessToken,
    workspaceIds: candidate.workspaceIds,
    ...(candidate.expectedSyncEpoch === undefined ? {} : { expectedSyncEpoch: candidate.expectedSyncEpoch as string }),
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
  if (candidate.type === 'document.update') {
    if (typeof candidate.workspaceId !== 'string'
      || typeof candidate.documentId !== 'string'
      || typeof candidate.objectId !== 'string'
      || typeof candidate.kind !== 'string'
      || typeof candidate.updateId !== 'string'
      || typeof candidate.keyVersion !== 'number' || !Number.isSafeInteger(candidate.keyVersion)
      || candidate.keyVersion < 1
      || typeof candidate.ciphertext !== 'string'
      || typeof candidate.ciphertextHash !== 'string'
      || candidate.ciphertext.length > 4 * 1024 * 1024) {
      throw new Error('Document update message is invalid')
    }
    return {
      type: 'document.update',
      workspaceId: candidate.workspaceId,
      documentId: candidate.documentId.slice(0, 200),
      objectId: candidate.objectId.slice(0, 200),
      kind: candidate.kind.slice(0, 40),
      updateId: candidate.updateId.slice(0, 200),
      keyVersion: candidate.keyVersion,
      ciphertext: candidate.ciphertext,
      ciphertextHash: candidate.ciphertextHash.slice(0, 200),
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
      peer.socket.send(payload)
    }
  }
}

function relayDocumentUpdate(
  message: DocumentUpdateMessage,
  connection: PresenceConnection,
  rooms: Map<string, Set<PresenceConnection>>,
): void {
  if (!connection.workspaceIds.has(message.workspaceId)) throw new Error('Workspace is not subscribed')
  const room = rooms.get(message.workspaceId)
  if (!room) return
  const payload = JSON.stringify({
    ...message,
    type: 'document.updated.realtime',
    deviceId: connection.deviceId,
  })
  for (const peer of room) {
    if (peer !== connection
      && peer.documentIds.has(`${message.workspaceId}\0${message.documentId}`)
      && peer.socket.readyState === peer.socket.OPEN) {
      peer.socket.send(payload)
    }
  }
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
    if (peer !== connection && peer.socket.readyState === peer.socket.OPEN) peer.socket.send(payload)
  }
}

function sendPresence(presence: PresenceState, socket: WebSocket): void {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify({
    type: 'presence.updated',
    workspaceId: presence.workspaceId,
    documentId: presence.documentId,
    deviceId: presence.deviceId,
    label: presence.label,
    anchor: presence.anchor,
    head: presence.head,
  }))
}
