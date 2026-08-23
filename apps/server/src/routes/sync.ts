import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AuthService } from '../auth/service.js'
import { requireAuth } from '../auth/http-auth.js'
import type { TokenService } from '../auth/tokens.js'
import type { DurableSyncService } from '../durable-sync/service.js'
import { NullableTimestamp, SyncObjectKindSchema, Timestamp } from './api-schemas.js'

const Counter = Type.String({ pattern: '^\\d{1,19}$' })
const Hash = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })
const WorkspaceParams = Type.Object({ workspaceId: Type.String({ format: 'uuid' }) })
const ObjectVersionParams = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  objectId: Type.String({ format: 'uuid' }),
  revision: Counter,
})
const Kind = SyncObjectKindSchema
const Capability = Type.Union([
  Type.Literal('content.read'), Type.Literal('content.create'), Type.Literal('content.update'),
  Type.Literal('content.delete'), Type.Literal('history.view'), Type.Literal('history.restore'),
  Type.Literal('member.invite'), Type.Literal('member.update'), Type.Literal('member.remove'),
  Type.Literal('workspace.rename'), Type.Literal('workspace.delete'),
])
const Envelope = {
  keyVersion: Type.Integer({ minimum: 1 }),
  ciphertext: Type.String({ pattern: '^[A-Za-z0-9_-]+$' }),
  ciphertextHash: Hash,
}
const OptionalNameCiphertext = Type.Optional(Type.Union([
  Type.String({ maxLength: 16 * 1024 }), Type.Null(),
]))
const CommandId = { commandId: Type.String({ format: 'uuid' }) }
const NullableUuid = Type.Union([Type.String({ format: 'uuid' }), Type.Null()])
const NullableCounter = Type.Union([Counter, Type.Null()])
const NullableString = Type.Union([Type.String(), Type.Null()])
const SyncEpochField = { syncEpoch: Type.String({ format: 'uuid' }) }
const CommandResult = Type.Object({
  commandId: Type.String({ format: 'uuid' }),
  status: Type.Union([Type.Literal('applied'), Type.Literal('conflict'), Type.Literal('rejected')]),
  duplicate: Type.Boolean(),
  sequence: Type.Optional(Counter),
  revision: Type.Optional(Counter),
  documentSequence: Type.Optional(Counter),
  conflictId: Type.Optional(Type.String({ format: 'uuid' })),
  code: Type.Optional(Type.String()),
  retryable: Type.Optional(Type.Boolean()),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})
const SyncEvent = Type.Object({
  eventId: Type.String({ format: 'uuid' }),
  commandId: Type.String({ format: 'uuid' }),
  sourceDeviceId: Type.String({ format: 'uuid' }),
  type: Type.String(),
  objectId: NullableUuid,
  documentId: NullableString,
  sequence: Counter,
  documentSequence: NullableCounter,
  keyVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  ciphertext: NullableString,
  ciphertextHash: Type.Union([Hash, Type.Null()]),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Timestamp,
})
const ObjectVersion = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  objectId: Type.String({ format: 'uuid' }),
  revision: Counter,
  sequence: Counter,
  kind: Kind,
  parentObjectId: NullableUuid,
  nameCiphertext: NullableString,
  nameBlindIndex: NullableString,
  ciphertext: Type.String(),
  ciphertextHash: Hash,
  keyVersion: Type.Integer({ minimum: 1 }),
  blobRefs: Type.Array(Hash),
  sourceDeviceId: Type.String({ format: 'uuid' }),
  deleted: Type.Boolean(),
  createdAt: Timestamp,
})
const Conflict = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  conflictId: Type.String({ format: 'uuid' }),
  objectId: Type.String({ format: 'uuid' }),
  kind: Kind,
  type: Type.String(),
  status: Type.String(),
  expectedRevision: NullableCounter,
  expectedDocumentSequence: NullableCounter,
  keyVersion: Type.Integer({ minimum: 1 }),
  ciphertext: Type.String(),
  ciphertextHash: Hash,
  createdSequence: Counter,
  resolvedSequence: NullableCounter,
  resolvedByDeviceId: NullableUuid,
  resolvedAt: NullableTimestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
const Command = Type.Union([
  Type.Object({
    ...CommandId, type: Type.Literal('upsert-object'), objectId: Type.String({ format: 'uuid' }),
    kind: Kind, parentObjectId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
    nameCiphertext: OptionalNameCiphertext,
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
    nameCiphertext: OptionalNameCiphertext,
    baseRevision: Counter, expectedDocumentSequence: Counter, blobRefs: Type.Array(Hash, { maxItems: 1_000 }),
    conflictId: Type.String({ format: 'uuid' }), conflictCiphertext: Type.String({ pattern: '^[A-Za-z0-9_-]+$' }),
    conflictCiphertextHash: Hash, ...Envelope,
  }),
  Type.Object({
    ...CommandId, type: Type.Literal('delete-subtree'), rootObjectId: Type.String({ format: 'uuid' }),
    conflictId: Type.String({ format: 'uuid' }), conflictKeyVersion: Type.Integer({ minimum: 1 }),
    conflictCiphertext: Type.String({ pattern: '^[A-Za-z0-9_-]+$' }), conflictCiphertextHash: Hash,
    mutationIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 2_000 })),
    objects: Type.Array(Type.Object({
      objectId: Type.String({ format: 'uuid' }), kind: Kind, baseRevision: Counter,
      expectedDocumentSequence: Counter, blobRefs: Type.Array(Hash, { maxItems: 1_000 }), ...Envelope,
    }), { minItems: 1, maxItems: 2_000 }),
  }),
  Type.Object({
    ...CommandId, type: Type.Literal('initialize-document'), updateId: Type.String({ format: 'uuid' }),
    documentId: Type.String({ minLength: 1, maxLength: 512 }), objectId: Type.String({ format: 'uuid' }),
    kind: Kind, ...Envelope,
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
      nameCiphertext: OptionalNameCiphertext,
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
    app.get('/v1/workspaces/:workspaceId/sync/session', {
      schema: {
        params: WorkspaceParams,
        querystring: Type.Object({
          protocolVersion: Type.Integer({ minimum: 1 }),
          cursor: Type.Optional(Counter),
          expectedSyncEpoch: Type.Optional(Type.String({ format: 'uuid' })),
        }),
        response: {
          200: Type.Object({
            protocol: Type.Object({
              requestedVersion: Type.Integer(),
              selectedVersion: Type.Literal(1),
              compatible: Type.Boolean(),
            }),
            workspace: Type.Object({
              id: Type.String({ format: 'uuid' }),
              type: Type.Union([Type.Literal('account-data'), Type.Literal('library')]),
              role: Type.Union([
                Type.Literal('owner'), Type.Literal('viewer'), Type.Literal('editor'), Type.Literal('manager'),
              ]),
              owner: Type.Boolean(),
              capabilities: Type.Array(Capability),
            }),
            cursor: Type.Object({
              supplied: Counter,
              state: Type.Union([Type.Literal('valid'), Type.Literal('ahead'), Type.Literal('expired')]),
              acknowledged: Counter,
              oldestAvailableSequence: Type.Union([Counter, Type.Null()]),
            }),
            latestSequence: Counter,
            bootstrap: Type.Object({
              required: Type.Boolean(),
              reason: Type.Union([
                Type.Literal('cursor_ahead'), Type.Literal('cursor_expired'),
                Type.Literal('device_uninitialized'), Type.Literal('lag_too_large'), Type.Null(),
              ]),
            }),
            limits: Type.Object({
              maxCommandsPerBatch: Type.Integer(),
              maxEventsPerPage: Type.Integer(),
              maxBootstrapObjectsPerPage: Type.Integer(),
              maxDocumentUpdatesPerPage: Type.Integer(),
              maxObjectBytes: Type.Integer(),
            }),
            keyVersions: Type.Array(Type.Object({
              keyVersion: Type.Integer({ minimum: 1 }),
              createdAt: Timestamp,
            })),
            syncEpoch: Type.String({ format: 'uuid' }),
            websocketUrl: Type.String({ format: 'uri' }),
          }),
        },
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      const session = await sync.session(
        claims.accountId,
        claims.deviceId,
        request.params.workspaceId,
        request.query.cursor ?? '0',
        request.query.protocolVersion,
        request.query.expectedSyncEpoch,
      )
      const websocketScheme = request.protocol === 'https' ? 'wss' : 'ws'
      return {
        ...session,
        websocketUrl: `${websocketScheme}://${request.host}/v1/sync/events`,
      }
    })

    app.post('/v1/workspaces/:workspaceId/sync/commands', {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: {
        params: WorkspaceParams,
        body: Type.Object({
          commands: Type.Array(Command, { minItems: 1, maxItems: 100 }),
          expectedSyncEpoch: Type.String({ format: 'uuid' }),
        }),
        response: { 200: Type.Object({ results: Type.Array(CommandResult), ...SyncEpochField }) },
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

    app.post('/v1/workspaces/:workspaceId/sync/ack', {
      schema: {
        params: WorkspaceParams,
        body: Type.Object({
          through: Counter,
          expectedSyncEpoch: Type.String({ format: 'uuid' }),
        }),
        response: { 200: Type.Object({ acknowledgedSequence: Counter, ...SyncEpochField }) },
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.acknowledge(
        claims.accountId, claims.deviceId, request.params.workspaceId,
        request.body.through, request.body.expectedSyncEpoch,
      )
    })

    app.get('/v1/workspaces/:workspaceId/sync/events', {
      schema: {
        params: WorkspaceParams,
        querystring: Type.Object({ after: Type.Optional(Counter), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })), expectedSyncEpoch: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({
          events: Type.Array(SyncEvent), nextCursor: Counter, latestSequence: Counter,
          hasMore: Type.Boolean(), ...SyncEpochField,
        }) },
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return sync.events(claims.accountId, request.params.workspaceId, request.query.after ?? '0', request.query.limit ?? 200, request.query.expectedSyncEpoch)
    })

    app.get('/v1/workspaces/:workspaceId/sync/objects/:objectId/versions/:revision', {
        schema: {
          params: ObjectVersionParams,
          querystring: Type.Object({ expectedSyncEpoch: Type.String({ format: 'uuid' }) }),
          response: { 200: Type.Object({
            object: Type.Intersect([ObjectVersion, Type.Object({ currentRevision: NullableCounter })]),
            resources: Type.Array(Type.Intersect([ObjectVersion, Type.Object({ currentRevision: NullableCounter })])),
            ...SyncEpochField,
          }) },
        },
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
          expectedSyncEpoch: Type.String({ format: 'uuid' }),
        }),
        response: { 200: Type.Object({
          versions: Type.Array(ObjectVersion), nextBefore: NullableCounter,
          hasMore: Type.Boolean(), ...SyncEpochField,
        }) },
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
          expectedSyncEpoch: Type.String({ format: 'uuid' }),
        }),
        response: { 200: Type.Object({
          bootstrapId: Type.String({ format: 'uuid' }),
          snapshotSequence: Counter,
          objects: Type.Array(Type.Object({
            objectId: Type.String({ format: 'uuid' }), kind: Kind, parentObjectId: NullableUuid,
            nameCiphertext: NullableString, nameBlindIndexPresent: Type.Boolean(), currentRevision: Counter,
            ciphertext: Type.String(), ciphertextHash: Hash, keyVersion: Type.Integer({ minimum: 1 }),
            blobRefs: Type.Array(Hash), deletedAt: NullableTimestamp,
            document: Type.Union([Type.Object({
              documentId: Type.String(), latestDocumentSequence: Counter, checkpointDocumentSequence: Counter,
              checkpointId: NullableUuid, checkpointKeyVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
              checkpointCiphertext: NullableString, checkpointCiphertextHash: Type.Union([Hash, Type.Null()]),
              materializedRevision: NullableCounter,
            }), Type.Null()]),
          })),
          conflicts: Type.Array(Conflict), nextObjectId: NullableUuid,
          hasMore: Type.Boolean(), ...SyncEpochField,
        }) },
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
        querystring: Type.Object({ after: Type.Optional(Counter), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })), expectedSyncEpoch: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({
          updates: Type.Array(Type.Object({
            workspaceId: Type.String({ format: 'uuid' }), documentId: Type.String(), documentSequence: Counter,
            updateId: Type.String({ format: 'uuid' }), eventSequence: Counter,
            sourceDeviceId: Type.String({ format: 'uuid' }), keyVersion: Type.Integer({ minimum: 1 }),
            ciphertext: Type.String(), ciphertextHash: Hash, createdAt: Timestamp,
          })),
          checkpoint: Type.Union([Type.Object({
            objectId: Type.String({ format: 'uuid' }), documentSequence: Counter,
            checkpointId: Type.String({ format: 'uuid' }), keyVersion: Type.Integer({ minimum: 1 }),
            ciphertext: Type.String(), ciphertextHash: Hash,
          }), Type.Null()]),
          nextDocumentSequence: Counter, hasMore: Type.Boolean(), ...SyncEpochField,
        }) },
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
