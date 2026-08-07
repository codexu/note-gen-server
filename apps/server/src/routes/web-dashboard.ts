import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { WebSessionService } from '../auth/web-session-service.js'
import type { SyncService } from '../sync/service.js'
import type { WorkspaceService } from '../workspaces/service.js'
import type { AdminService } from '../admin/service.js'
import {
  CounterString, HashString, KeyEnvelopeResponse, NullableTimestamp, SyncObjectKindSchema, Timestamp,
} from './api-schemas.js'
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
  sync: SyncService,
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

    app.get('/v1/web/workspaces/:workspaceId/keys', {
      schema: {
        params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Array(Type.Object({
            keyVersion: Type.Integer(),
            createdAt: Timestamp,
            envelopes: Type.Array(KeyEnvelopeResponse),
          })),
        },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return workspaces.listKeys(session.accountId, request.params.workspaceId)
    })

    app.get('/v1/web/workspaces/:workspaceId/objects', {
      schema: {
        params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          kind: Type.Optional(SyncObjectKindSchema),
          status: Type.Optional(Type.Union([
            Type.Literal('active'), Type.Literal('deleted'), Type.Literal('all'),
          ])),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
        }),
        response: {
          200: Type.Object({
            total: Type.Integer(),
            objects: Type.Array(Type.Object({
              objectId: Type.String({ format: 'uuid' }),
              kind: SyncObjectKindSchema,
              currentRevision: CounterString,
              ciphertext: Type.String(),
              ciphertextHash: HashString,
              ciphertextBytes: CounterString,
              keyVersion: Type.Integer(),
              blobRefs: Type.Array(HashString),
              deletedAt: NullableTimestamp,
              createdAt: Timestamp,
              updatedAt: Timestamp,
            })),
          }),
        },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return workspaces.listAccountWorkspaceObjects(session.accountId, request.params.workspaceId, {
        ...(request.query.kind === undefined ? {} : { kind: request.query.kind }),
        status: request.query.status ?? 'active',
        limit: request.query.limit ?? 100,
        offset: request.query.offset ?? 0,
      })
    })

    app.post('/v1/web/workspaces/:workspaceId/test-objects', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }),
        body: Type.Object({
          kind: Type.Union([
            Type.Literal('note'), Type.Literal('record'), Type.Literal('canvas'), Type.Literal('setting'),
          ]),
        }),
        response: {
          201: Type.Object({
            objectId: Type.String({ format: 'uuid' }),
            revision: CounterString,
            sequence: CounterString,
          }),
        },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(
        request.headers['x-csrf-token'],
        request.cookies[WEB_CSRF_COOKIE],
        session,
        webSessions,
      )
      const created = await sync.createWebTestObject(
        session.accountId,
        request.params.workspaceId,
        request.body.kind,
      )
      await admin?.recordAudit(session.accountId, 'test-object.create', 'object', created.objectId, {
        workspaceId: request.params.workspaceId,
        kind: request.body.kind,
      }).catch((error: unknown) => request.log.warn({ err: error }, 'Failed to record test object audit'))
      return reply.status(201).send(created)
    })

    app.get('/v1/web/workspaces/:workspaceId/test-objects', { schema: {
      params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }),
      response: { 200: Type.Array(Type.Object({
        objectId: Type.String({ format: 'uuid' }), kind: SyncObjectKindSchema,
        createdAt: Timestamp, deletedAt: NullableTimestamp,
      })) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return sync.listWebTestObjects(session.accountId, request.params.workspaceId)
    })

    app.delete('/v1/web/workspaces/:workspaceId/test-objects', { schema: {
      params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }),
      response: { 200: Type.Object({ deleted: Type.Integer(), skipped: Type.Integer() }) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      const result = await sync.cleanupWebTestObjects(session.accountId, request.params.workspaceId)
      await admin?.recordAudit(session.accountId, 'test-object.cleanup', 'workspace', request.params.workspaceId, result)
        .catch((error: unknown) => request.log.warn({ err: error }, 'Failed to record test cleanup audit'))
      return result
    })

    app.delete('/v1/web/workspaces/:workspaceId/objects/:objectId', {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        params: Type.Object({
          workspaceId: Type.String({ format: 'uuid' }),
          objectId: Type.String({ format: 'uuid' }),
        }),
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
      await sync.deleteWebObject(session.accountId, request.params.workspaceId, request.params.objectId)
      await admin?.recordAudit(session.accountId, 'object.delete', 'object', request.params.objectId, {
        workspaceId: request.params.workspaceId,
      }).catch((error: unknown) => request.log.warn({ err: error }, 'Failed to record object deletion audit'))
      return reply.status(204).send()
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
      return reply.status(204).send()
    })
  }
}
