import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { requireAuth } from '../auth/http-auth.js'
import type { TokenService } from '../auth/tokens.js'
import type { AuthService } from '../auth/service.js'
import type { SyncService } from '../sync/service.js'
import { syncObjectKinds } from '../sync/types.js'
import {
  BootstrapObjectResponse, ChangeResponse, CounterString, ObjectVersionResponse, PushResponse,
  PushResultResponse,
} from './api-schemas.js'

const WorkspaceParams = Type.Object({ workspaceId: Type.String({ format: 'uuid' }) })
const ObjectParams = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  objectId: Type.String({ format: 'uuid' }),
})
const Counter = Type.String({ pattern: '^\\d{1,19}$' })
const ObjectKind = Type.Union(syncObjectKinds.map((kind) => Type.Literal(kind)))
const PushOperation = Type.Object({
  operationId: Type.String({ format: 'uuid' }),
  objectId: Type.String({ format: 'uuid' }),
  kind: ObjectKind,
  baseRevision: Type.Union([Counter, Type.Null()]),
  keyVersion: Type.Integer({ minimum: 1 }),
  ciphertext: Type.String({ pattern: '^[A-Za-z0-9_-]+$' }),
  ciphertextHash: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
  blobRefs: Type.Array(Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }), { maxItems: 1_000 }),
  delete: Type.Boolean(),
})

export function createSyncRoutes(
  sync: SyncService,
  tokens: TokenService,
  auth: AuthService,
): FastifyPluginAsyncTypebox {
  return async function syncRoutes(app) {
    app.post('/v1/workspaces/:workspaceId/sync/push', {
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      schema: {
        params: WorkspaceParams,
        body: Type.Object({ operations: Type.Array(PushOperation, { minItems: 1, maxItems: 100 }) }),
        response: { 200: PushResponse },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.push(claims.accountId, claims.deviceId, request.params.workspaceId, request.body.operations)
    })

    app.get('/v1/workspaces/:workspaceId/sync/changes', {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: {
        params: WorkspaceParams,
        querystring: Type.Object({
          after: Type.Optional(Counter),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
        }),
        response: {
          200: Type.Object({
            changes: Type.Array(ChangeResponse),
            nextCursor: CounterString,
            hasMore: Type.Boolean(),
            latestSequence: CounterString,
          }),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.pull(claims.accountId, request.params.workspaceId, request.query.after ?? '0', request.query.limit ?? 200)
    })

    app.post('/v1/workspaces/:workspaceId/sync/session', {
      schema: {
        params: WorkspaceParams,
        body: Type.Object({ cursor: Counter }),
        response: {
          200: Type.Object({
            latestSequence: CounterString,
            cursorValid: Type.Boolean(),
            bootstrapRequired: Type.Boolean(),
            webSocketPath: Type.String(),
          }),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.session(claims.accountId, request.params.workspaceId, request.body.cursor)
    })

    app.put('/v1/workspaces/:workspaceId/sync/cursor', {
      schema: { params: WorkspaceParams, body: Type.Object({ cursor: Counter }), response: { 204: Type.Null() } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await sync.acknowledge(claims.accountId, claims.deviceId, request.params.workspaceId, request.body.cursor)
      return reply.status(204).send()
    })

    app.get('/v1/workspaces/:workspaceId/sync/bootstrap', {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: {
        params: WorkspaceParams,
        querystring: Type.Object({
          afterObjectId: Type.Optional(Type.String({ format: 'uuid' })),
          bootstrapSessionId: Type.Optional(Type.String({ format: 'uuid' })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
        }),
        response: {
          200: Type.Object({
            objects: Type.Array(BootstrapObjectResponse),
            nextObjectId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
            hasMore: Type.Boolean(),
            snapshotSequence: CounterString,
            bootstrapSessionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
          }),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.bootstrap(
        claims.accountId,
        claims.deviceId,
        request.params.workspaceId,
        request.query.afterObjectId ?? null,
        request.query.limit ?? 200,
        request.query.bootstrapSessionId ?? null,
      )
    })

    app.get('/v1/workspaces/:workspaceId/objects/:objectId/history', {
      schema: {
        params: ObjectParams,
        querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
        response: { 200: Type.Array(ObjectVersionResponse) },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.history(claims.accountId, request.params.workspaceId, request.params.objectId, request.query.limit ?? 100)
    })

    app.post('/v1/workspaces/:workspaceId/objects/:objectId/history/:revision/restore', {
      schema: {
        params: Type.Intersect([ObjectParams, Type.Object({ revision: Counter })]),
        body: Type.Object({
          operationId: Type.String({ format: 'uuid' }),
          baseRevision: Counter,
        }),
        response: { 200: PushResultResponse },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.restore(
        claims.accountId, claims.deviceId, request.params.workspaceId,
        request.params.objectId, request.params.revision,
        request.body.operationId, request.body.baseRevision,
      )
    })
  }
}
