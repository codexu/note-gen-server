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
}

export function createEventRoutes(
  tokens: TokenService,
  auth: AuthService,
  workspaces: WorkspaceService,
  notifier: ChangeNotifier,
): FastifyPluginAsyncTypebox {
  return async function eventRoutes(app) {
    app.get('/v1/sync/events', {
      websocket: true,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    }, (socket) => {
      let authenticated = false
      let alive = true
      const unsubscribe: Array<() => void> = []
      let sessionTimeout: NodeJS.Timeout | undefined
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
      }

      const handleMessage = async (raw: RawData, currentSocket: WebSocket): Promise<void> => {
        if (authenticated) return
        try {
          const message = parseAuthenticateMessage(raw)
          const claims = await tokens.verifyAccessToken(message.accessToken)
          await auth.assertDeviceActive(claims.accountId, claims.deviceId)
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

function parseAuthenticateMessage(raw: RawData): AuthenticateMessage {
  const value: unknown = JSON.parse(raw.toString())
  if (typeof value !== 'object' || value === null) throw new Error('Message must be an object')
  const candidate = value as Record<string, unknown>
  if (candidate.type !== 'authenticate' || typeof candidate.accessToken !== 'string'
    || !Array.isArray(candidate.workspaceIds)
    || !candidate.workspaceIds.every((id) => typeof id === 'string')) {
    throw new Error('Authentication message is invalid')
  }
  return {
    type: 'authenticate',
    accessToken: candidate.accessToken,
    workspaceIds: candidate.workspaceIds,
  }
}
