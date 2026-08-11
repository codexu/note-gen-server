import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { WebSessionService } from '../auth/web-session-service.js'
import type { WorkspaceService } from '../workspaces/service.js'
import type { AdminService } from '../admin/service.js'
import { CounterString, NullableTimestamp, Timestamp } from './api-schemas.js'
import {
  requireCsrf, requireWebSession, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE,
} from './web-auth.js'

const Activity = Type.Object({
  sequence: CounterString,
  kind: Type.String(),
  changeType: Type.Union([Type.Literal('upsert'), Type.Literal('delete')]),
  createdAt: Timestamp,
  device: Type.Object({
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    platform: Type.String(),
  }),
})

export function createWebDashboardRoutes(
  workspaces: WorkspaceService,
  webSessions: WebSessionService,
  admin?: AdminService,
): FastifyPluginAsyncTypebox {
  return async function webDashboardRoutes(app) {
    app.get('/v1/web/sync-overview', {
      schema: {
        response: {
          200: Type.Object({
            workspaceCount: Type.Integer(),
            objectCount: Type.Integer(),
            deletedObjectCount: Type.Integer(),
            objectBytes: CounterString,
            blobCount: Type.Integer(),
            blobBytes: CounterString,
            latestSequence: CounterString,
            lastActivityAt: NullableTimestamp,
            encryptionMode: Type.Union([
              Type.Literal('managed'), Type.Literal('e2ee'), Type.Literal('mixed'), Type.Null(),
            ]),
            kinds: Type.Array(Type.Object({
              kind: Type.String(),
              activeCount: Type.Integer(),
              deletedCount: Type.Integer(),
              updatedAt: Timestamp,
            })),
            recentActivity: Type.Array(Activity),
          }),
        },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return workspaces.getAccountSyncOverview(session.accountId)
    })

    app.get('/v1/web/workspaces', {
      schema: {
        response: {
          200: Type.Array(Type.Object({
            id: Type.String({ format: 'uuid' }),
            nameCiphertext: Type.String(),
            isDefault: Type.Boolean(),
            latestSequence: CounterString,
            latestKeyVersion: Type.Integer(),
            encryptionMode: Type.Union([Type.Literal('managed'), Type.Literal('e2ee')]),
            objectCount: Type.Integer(),
            deletedObjectCount: Type.Integer(),
            createdAt: Timestamp,
            updatedAt: Timestamp,
          })),
        },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return workspaces.listAccountWorkspaces(session.accountId)
    })

    app.delete('/v1/web/workspaces/:workspaceId', {
      schema: {
        params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(
        request.headers['x-csrf-token'],
        request.cookies[WEB_CSRF_COOKIE],
        session,
        webSessions,
      )
      await workspaces.remove(session.accountId, request.params.workspaceId, { allowDefault: false })
      await admin?.recordAudit(session.accountId, 'workspace.delete', 'workspace', request.params.workspaceId)
        .catch((error: unknown) => request.log.warn({ err: error }, 'Failed to record workspace deletion audit'))
      return reply.status(204).send(null)
    })
  }
}
