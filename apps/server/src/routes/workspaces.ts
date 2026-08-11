import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import { requireAuth } from '../auth/http-auth.js'
import type { TokenService } from '../auth/tokens.js'
import type { AuthService } from '../auth/service.js'
import type { WorkspaceService } from '../workspaces/service.js'
import { ApiError } from '../errors.js'
import { CounterString, KeyEnvelopeResponse, NullableTimestamp, Timestamp } from './api-schemas.js'

const KeyEnvelope = Type.Object({
  type: Type.Union([Type.Literal('passphrase'), Type.Literal('recovery'), Type.Literal('device')]),
  recipientId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  wrappedKey: Type.String({ minLength: 1, maxLength: 8_192 }),
  kdfSalt: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  kdfParams: Type.Union([Type.Record(Type.String(), Type.Number()), Type.Null()]),
})
const KeyBody = Type.Object({
  keyVersion: Type.Integer({ minimum: 1 }),
  envelopes: Type.Array(KeyEnvelope, { minItems: 1, maxItems: 100 }),
})
const WorkspaceParams = Type.Object({ workspaceId: Type.String({ format: 'uuid' }) })
const IdempotencyKeyHeaders = Type.Object({
  'idempotency-key': Type.Optional(Type.String({ minLength: 16, maxLength: 200, pattern: '^[A-Za-z0-9._-]+$' })),
})

export function createWorkspaceRoutes(
  config: AppConfig,
  workspaces: WorkspaceService,
  tokens: TokenService,
  auth: AuthService,
): FastifyPluginAsyncTypebox {
  return async function workspaceRoutes(app) {
    app.post('/v1/workspaces/default', {
      schema: {
        body: Type.Object({
          nameCiphertext: Type.String({ minLength: 1, maxLength: 8_192 }),
          managedKey: Type.String({ minLength: 40, maxLength: 128 }),
        }),
        response: {
          200: Type.Object({
            id: Type.String({ format: 'uuid' }),
            created: Type.Boolean(),
            encryptionMode: Type.Union([Type.Literal('managed'), Type.Literal('e2ee')]),
            createdAt: Timestamp,
            latestSequence: CounterString,
            nameCiphertext: Type.String(),
          }),
        },
      },
    }, async (request) => {
      if (config.deploymentMode === 'hosted' && config.hostedReleaseStage === 'internal-test') {
        throw new ApiError({ code: 'managed_default_workspace_unavailable', message: 'Managed default workspace is unavailable during internal E2EE testing', statusCode: 409 })
      }
      const claims = await requireAuth(request, tokens, auth)
      return workspaces.getOrCreateManagedDefault(claims.accountId, request.body)
    })

    app.post('/v1/workspaces', {
      schema: {
        headers: IdempotencyKeyHeaders,
        body: Type.Intersect([KeyBody, Type.Object({
          nameCiphertext: Type.String({ minLength: 1, maxLength: 8_192 }),
        })]),
        response: {
          200: Type.Object({
            id: Type.String({ format: 'uuid' }),
            createdAt: Timestamp,
            latestSequence: CounterString,
            nameCiphertext: Type.String(),
            created: Type.Boolean(),
          }),
          201: Type.Object({
            id: Type.String({ format: 'uuid' }),
            createdAt: Timestamp,
            latestSequence: CounterString,
            nameCiphertext: Type.String(),
            created: Type.Boolean(),
          }),
        },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      const idempotencyKey = typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key'] : undefined
      const result = await workspaces.create(claims.accountId, {
        ...request.body,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      })
      return reply.status(result.created ? 201 : 200).send(result)
    })

    app.get('/v1/workspace-creation-requests/:idempotencyKey', {
      schema: {
        params: Type.Object({
          idempotencyKey: Type.String({ minLength: 16, maxLength: 200, pattern: '^[A-Za-z0-9._-]+$' }),
        }),
        response: { 200: Type.Object({ id: Type.String({ format: 'uuid' }), createdAt: Timestamp }) },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      const workspace = await workspaces.getCreationRequest(claims.accountId, request.params.idempotencyKey)
      if (workspace === undefined) {
        throw new ApiError({ code: 'workspace_creation_not_found', message: 'Workspace creation was not found', statusCode: 404 })
      }
      return workspace
    })

    app.get('/v1/workspaces', {
      schema: {
        querystring: Type.Object({ includeDeleted: Type.Optional(Type.Boolean()) }),
        response: {
          200: Type.Array(Type.Object({
            id: Type.String({ format: 'uuid' }),
            nameCiphertext: Type.String(),
            latestSequence: CounterString,
            latestKeyVersion: Type.Integer(),
            hasDeviceEnvelope: Type.Boolean(),
            encryptionMode: Type.Union([Type.Literal('managed'), Type.Literal('e2ee')]),
            createdAt: Timestamp,
            updatedAt: Timestamp,
            deletedAt: NullableTimestamp,
          })),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return workspaces.list(claims.accountId, claims.deviceId, request.query.includeDeleted ?? false)
    })

    app.get('/v1/workspaces/:workspaceId/keys', {
      schema: {
        params: WorkspaceParams,
        response: {
          200: Type.Array(Type.Object({
            keyVersion: Type.Integer(),
            createdAt: Timestamp,
            envelopes: Type.Array(KeyEnvelopeResponse),
          })),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return workspaces.listKeys(claims.accountId, request.params.workspaceId)
    })

    app.post('/v1/workspaces/:workspaceId/keys', {
      schema: {
        params: WorkspaceParams,
        body: KeyBody,
        response: { 201: Type.Object({ keyVersion: Type.Integer(), createdAt: Timestamp }) },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      return reply.status(201).send(await workspaces.addKey(
        claims.accountId,
        request.params.workspaceId,
        request.body,
      ))
    })

    app.post('/v1/workspaces/:workspaceId/keys/:keyVersion/envelopes', {
      schema: {
        params: Type.Object({
          workspaceId: Type.String({ format: 'uuid' }),
          keyVersion: Type.Integer({ minimum: 1 }),
        }),
        body: KeyEnvelope,
        response: { 201: KeyEnvelopeResponse },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      return reply.status(201).send(await workspaces.addEnvelope(
        claims.accountId, request.params.workspaceId, request.params.keyVersion, request.body,
      ))
    })

    app.put('/v1/workspaces/:workspaceId/keys/:keyVersion/recovery-envelope', {
      schema: {
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 16, maxLength: 200, pattern: '^[A-Za-z0-9._-]+$' }),
        }),
        params: Type.Object({
          workspaceId: Type.String({ format: 'uuid' }),
          keyVersion: Type.Integer({ minimum: 1 }),
        }),
        body: KeyEnvelope,
        response: { 200: Type.Object({ id: Type.String({ format: 'uuid' }), status: Type.Literal('active'), created: Type.Boolean() }) },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      const idempotencyKey = request.headers['idempotency-key']
      if (typeof idempotencyKey !== 'string') {
        throw new ApiError({ code: 'idempotency_key_invalid', message: 'Idempotency-Key is required', statusCode: 400 })
      }
      return workspaces.replaceRecoveryEnvelope(
        claims.accountId, request.params.workspaceId, request.params.keyVersion,
        request.body, idempotencyKey,
      )
    })

    app.put('/v1/workspaces/:workspaceId/keys/:keyVersion/encryption/e2ee', {
      schema: {
        params: Type.Object({
          workspaceId: Type.String({ format: 'uuid' }),
          keyVersion: Type.Integer({ minimum: 1 }),
        }),
        body: Type.Object({ envelopes: Type.Array(KeyEnvelope, { minItems: 2, maxItems: 2 }) }),
        response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await workspaces.enableEndToEndEncryption(
        claims.accountId,
        request.params.workspaceId,
        request.params.keyVersion,
        request.body.envelopes,
      )
      return reply.status(204).send(null)
    })

    app.put('/v1/workspaces/:workspaceId/encryption/managed', {
      schema: {
        params: WorkspaceParams,
        body: Type.Object({
          keys: Type.Array(Type.Object({
            keyVersion: Type.Integer({ minimum: 1 }),
            managedKey: Type.String({ minLength: 40, maxLength: 128 }),
          }), { minItems: 1, maxItems: 100 }),
        }),
        response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await workspaces.enableManagedEncryption(
        claims.accountId,
        request.params.workspaceId,
        request.body.keys,
      )
      return reply.status(204).send(null)
    })

    app.delete('/v1/workspaces/:workspaceId', {
      schema: { params: WorkspaceParams, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await workspaces.remove(claims.accountId, request.params.workspaceId)
      return reply.status(204).send(null)
    })

    app.post('/v1/workspaces/:workspaceId/restore', {
      schema: { params: WorkspaceParams, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await workspaces.restore(claims.accountId, request.params.workspaceId)
      return reply.status(204).send(null)
    })
  }
}
