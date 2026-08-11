import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AuthService } from '../auth/service.js'
import { requireAuth } from '../auth/http-auth.js'
import type { TokenService } from '../auth/tokens.js'
import type { DurableSyncService } from '../durable-sync/service.js'
import { syncObjectKinds } from '../sync/types.js'

const Counter = Type.String({ pattern: '^\\d{1,19}$' })
const Hash = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })
const WorkspaceParams = Type.Object({ workspaceId: Type.String({ format: 'uuid' }) })
const ObjectVersionParams = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  objectId: Type.String({ format: 'uuid' }),
  revision: Counter,
})
const Kind = Type.Union(syncObjectKinds.map(kind => Type.Literal(kind)))
const Envelope = {
  keyVersion: Type.Integer({ minimum: 1 }),
  ciphertext: Type.String({ pattern: '^[A-Za-z0-9_-]+$' }),
  ciphertextHash: Hash,
}
const CommandId = { commandId: Type.String({ format: 'uuid' }) }
const Command = Type.Union([
  Type.Object({
    ...CommandId, type: Type.Literal('upsert-object'), objectId: Type.String({ format: 'uuid' }),
    kind: Kind, parentObjectId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
    nameCiphertext: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    nameBlindIndex: Type.Optional(Type.Union([Hash, Type.Null()])),
    nameBlindIndexKeyVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    nameConflictId: Type.Optional(Type.String({ format: 'uuid' })),
    nameConflictCiphertext: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]+$' })),
    nameConflictCiphertextHash: Type.Optional(Hash),
    baseRevision: Type.Union([Counter, Type.Null()]), blobRefs: Type.Array(Hash, { maxItems: 1_000 }),
    resourceObjectIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 1_000 })),
    ...Envelope,
  }),
  Type.Object({
    ...CommandId, type: Type.Literal('delete-object'), objectId: Type.String({ format: 'uuid' }),
    kind: Kind, parentObjectId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
    nameCiphertext: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    baseRevision: Counter, expectedDocumentSequence: Counter, blobRefs: Type.Array(Hash, { maxItems: 1_000 }),
    conflictId: Type.String({ format: 'uuid' }), conflictCiphertext: Type.String({ pattern: '^[A-Za-z0-9_-]+$' }),
    conflictCiphertextHash: Hash, ...Envelope,
  }),
  Type.Object({
    ...CommandId, type: Type.Literal('delete-subtree'), rootObjectId: Type.String({ format: 'uuid' }),
    conflictId: Type.String({ format: 'uuid' }), conflictKeyVersion: Type.Integer({ minimum: 1 }),
    conflictCiphertext: Type.String({ pattern: '^[A-Za-z0-9_-]+$' }), conflictCiphertextHash: Hash,
    mutationIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 10_000 })),
    objects: Type.Array(Type.Object({
      objectId: Type.String({ format: 'uuid' }), kind: Kind, baseRevision: Counter,
      expectedDocumentSequence: Counter, blobRefs: Type.Array(Hash, { maxItems: 1_000 }), ...Envelope,
    }), { minItems: 1, maxItems: 10_000 }),
  }),
  Type.Object({
    ...CommandId, type: Type.Literal('append-update'), updateId: Type.String({ format: 'uuid' }),
    documentId: Type.String({ minLength: 1, maxLength: 512 }), objectId: Type.String({ format: 'uuid' }),
    kind: Kind, ...Envelope,
  }),
  Type.Object({
    ...CommandId, type: Type.Literal('commit-checkpoint'), checkpointId: Type.String({ format: 'uuid' }),
    documentId: Type.String({ minLength: 1, maxLength: 512 }), objectId: Type.String({ format: 'uuid' }),
    kind: Kind, coversDocumentSequence: Counter, materializedRevision: Type.Union([Counter, Type.Null()]), ...Envelope,
  }),
  Type.Object({
    ...CommandId, type: Type.Literal('create-conflict'), conflictId: Type.String({ format: 'uuid' }),
    objectId: Type.String({ format: 'uuid' }), kind: Kind, conflictType: Type.String({ minLength: 1, maxLength: 64 }),
    expectedRevision: Type.Union([Counter, Type.Null()]),
    expectedDocumentSequence: Type.Union([Counter, Type.Null()]), ...Envelope,
  }),
  Type.Object({
    ...CommandId, type: Type.Literal('resolve-conflict'), conflictId: Type.String({ format: 'uuid' }),
    expectedCreatedSequence: Counter,
    requiresCommandId: Type.Optional(Type.String({ format: 'uuid' })),
    deleteObject: Type.Optional(Type.Boolean()),
    objectResolution: Type.Optional(Type.Object({
      objectId: Type.String({ format: 'uuid' }), kind: Kind,
      parentObjectId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
      nameCiphertext: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      nameBlindIndex: Type.Optional(Type.Union([Hash, Type.Null()])),
      nameBlindIndexKeyVersion: Type.Optional(Type.Integer({ minimum: 1 })),
      blobRefs: Type.Optional(Type.Array(Hash, { maxItems: 1_000 })), ...Envelope,
      resourceObjectIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 1_000 })),
    })),
    resolution: Type.Optional(Type.Object({
      checkpointId: Type.String({ format: 'uuid' }), documentId: Type.String({ minLength: 1, maxLength: 512 }),
      objectId: Type.String({ format: 'uuid' }), kind: Kind, expectedDocumentSequence: Counter, ...Envelope,
    })),
  }),
])

export function createSyncRoutes(
  sync: DurableSyncService,
  tokens: TokenService,
  auth: AuthService,
): FastifyPluginAsyncTypebox {
  return async function syncRoutes(app) {
    app.post('/v1/workspaces/:workspaceId/sync/commands', {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: {
        params: WorkspaceParams,
        body: Type.Object({
          commands: Type.Array(Command, { minItems: 1, maxItems: 100 }),
          expectedSyncEpoch: Type.Optional(Type.String({ format: 'uuid' })),
        }),
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      const result = await sync.commands(
        claims.accountId, claims.deviceId, request.params.workspaceId,
        request.body.commands, request.body.expectedSyncEpoch,
      )
      void sync.recordCommandIngress(
        claims.accountId, request.params.workspaceId,
        BigInt(Buffer.byteLength(JSON.stringify(request.body.commands), 'utf8')), request.id,
      ).catch(error => request.log.warn({ err: error }, 'Failed to record sync command ingress usage'))
      return result
    })

    app.get('/v1/workspaces/:workspaceId/sync/events', {
      schema: {
        params: WorkspaceParams,
        querystring: Type.Object({ after: Type.Optional(Counter), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })), expectedSyncEpoch: Type.Optional(Type.String({ format: 'uuid' })) }),
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.events(claims.accountId, request.params.workspaceId, request.query.after ?? '0', request.query.limit ?? 200, request.query.expectedSyncEpoch)
    })

    app.get('/v1/workspaces/:workspaceId/sync/objects/:objectId/versions/:revision', {
      schema: { params: ObjectVersionParams, querystring: Type.Object({ expectedSyncEpoch: Type.Optional(Type.String({ format: 'uuid' })) }) },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.objectVersion(
        claims.accountId,
        request.params.workspaceId,
        request.params.objectId,
        request.params.revision, request.query.expectedSyncEpoch,
      )
    })

    app.get('/v1/workspaces/:workspaceId/sync/objects/:objectId/versions', {
      schema: {
        params: Type.Object({
          workspaceId: Type.String({ format: 'uuid' }),
          objectId: Type.String({ format: 'uuid' }),
        }),
        querystring: Type.Object({
          before: Type.Optional(Counter),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          expectedSyncEpoch: Type.Optional(Type.String({ format: 'uuid' })),
        }),
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.objectVersions(
        claims.accountId, request.params.workspaceId, request.params.objectId,
        request.query.before ?? null, request.query.limit ?? 20, request.query.expectedSyncEpoch,
      )
    })

    app.get('/v1/workspaces/:workspaceId/sync/bootstrap', {
      schema: {
        params: WorkspaceParams,
        querystring: Type.Object({
          bootstrapId: Type.Optional(Type.String({ format: 'uuid' })),
          afterObjectId: Type.Optional(Type.String({ format: 'uuid' })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
          expectedSyncEpoch: Type.Optional(Type.String({ format: 'uuid' })),
        }),
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.bootstrap(
        claims.accountId, request.params.workspaceId, request.query.bootstrapId ?? null,
        request.query.afterObjectId ?? null, request.query.limit ?? 200, request.query.expectedSyncEpoch,
      )
    })

    app.get('/v1/workspaces/:workspaceId/documents/:documentId/updates', {
      schema: {
        params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }), documentId: Type.String({ minLength: 1, maxLength: 512 }) }),
        querystring: Type.Object({ after: Type.Optional(Counter), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })), expectedSyncEpoch: Type.Optional(Type.String({ format: 'uuid' })) }),
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.documentUpdates(
        claims.accountId, request.params.workspaceId, request.params.documentId,
        request.query.after ?? '0', request.query.limit ?? 500, request.query.expectedSyncEpoch,
      )
    })
  }
}
