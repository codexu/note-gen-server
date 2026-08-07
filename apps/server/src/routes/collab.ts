import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { RawData, WebSocket } from 'ws'
import type { AuthService } from '../auth/service.js'
import type { TokenService } from '../auth/tokens.js'
import type { CollaborationService } from '../collab/service.js'
import type { WorkspaceService } from '../workspaces/service.js'

interface AuthenticateMessage {
  type: 'authenticate'
  accessToken: string
  workspaceId: string
  documentId: string
}

export function createCollaborationRoutes(
  collab: CollaborationService,
  tokens: TokenService,
  auth: AuthService,
  workspaces: WorkspaceService,
): FastifyPluginAsyncTypebox {
  return async function collaborationRoutes(app) {
    app.get('/v1/collab', { websocket: true }, (socket) => {
      let authenticated = false
      let unsubscribe: (() => void) | undefined
      let unsubscribeAwareness: (() => void) | undefined
      const authTimeout = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5_000)

      const cleanup = () => {
        clearTimeout(authTimeout)
        unsubscribe?.()
        unsubscribe = undefined
        unsubscribeAwareness?.()
        unsubscribeAwareness = undefined
      }
      socket.on('close', cleanup)
      socket.on('error', cleanup)
      socket.on('message', (raw) => void handleMessage(raw, socket))

      const handleMessage = async (raw: RawData, currentSocket: WebSocket): Promise<void> => {
        try {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>
          if (!authenticated) {
            if (message.type !== 'authenticate'
              || typeof message.accessToken !== 'string'
              || typeof message.workspaceId !== 'string'
              || typeof message.documentId !== 'string'
              || message.documentId.length === 0
              || message.documentId.length > 256) throw new Error('Invalid collaboration authentication')
            const authMessage = message as unknown as AuthenticateMessage
            const claims = await tokens.verifyAccessToken(authMessage.accessToken)
            await auth.assertDeviceActive(claims.accountId, claims.deviceId)
            await workspaces.assertOwned(claims.accountId, authMessage.workspaceId)
            const context = currentSocket as WebSocket & {
              __noteGenCollab?: AuthenticateMessage & { accountId: string, deviceId: string }
            }
            context.__noteGenCollab = {
              ...authMessage,
              accountId: claims.accountId,
              deviceId: claims.deviceId,
            }
            unsubscribe = collab.subscribe(authMessage.workspaceId, authMessage.documentId, (update) => {
              if (currentSocket.readyState === currentSocket.OPEN) {
                currentSocket.send(JSON.stringify({ type: 'update', ...update }))
              }
            })
            unsubscribeAwareness = collab.subscribeAwareness(authMessage.workspaceId, authMessage.documentId, (awareness) => {
              if (currentSocket.readyState === currentSocket.OPEN) {
                currentSocket.send(JSON.stringify({ type: 'awareness', ...awareness }))
              }
            })
            const updates = await collab.load(claims.accountId, authMessage.workspaceId, authMessage.documentId)
            authenticated = true
            clearTimeout(authTimeout)
            currentSocket.send(JSON.stringify({ type: 'ready', updates }))
            return
          }

          if (message.type === 'awareness') {
            if (typeof message.state !== 'string' || message.state.length > 64 * 1024) {
              throw new Error('Invalid collaboration awareness')
            }
            const context = currentSocket as WebSocket & { __noteGenCollab?: AuthenticateMessage & { accountId: string, deviceId: string } }
            const session = context.__noteGenCollab
            if (!session) throw new Error('Collaboration session is missing')
            collab.broadcastAwareness(session.workspaceId, session.documentId, session.deviceId, message.state)
            return
          }
          if ((message.type !== 'update' && message.type !== 'checkpoint') || typeof message.update !== 'string') {
            throw new Error('Invalid collaboration update')
          }
          // The authenticated connection is intentionally scoped to one document.
          // The connection-local claims are retained on the socket below.
          const context = currentSocket as WebSocket & { __noteGenCollab?: AuthenticateMessage & { accountId: string, deviceId: string } }
          const session = context.__noteGenCollab
          if (!session) throw new Error('Collaboration session is missing')
          await collab.append(
            session.accountId,
            session.deviceId,
            session.workspaceId,
            session.documentId,
            message.update,
            message.type === 'checkpoint',
          )
        } catch {
          currentSocket.close(1008, 'Collaboration authentication failed')
        }
      }
    })
  }
}
