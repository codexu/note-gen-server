import { timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'
import { requireAuth } from '../auth/http-auth.js'
import type { AuthService } from '../auth/service.js'
import type { TokenService } from '../auth/tokens.js'
import { NullableTimestamp, SessionResponse, Timestamp } from './api-schemas.js'

const SessionBody = Type.Object({
  login: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
  password: Type.String({ minLength: 8, maxLength: 1024 }),
  deviceId: Type.String({ format: 'uuid' }),
  deviceName: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
  platform: Type.String({ minLength: 1, maxLength: 50, pattern: '^[A-Za-z0-9._-]+$' }),
  encryptionPublicKey: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })),
  totpCode: Type.Optional(Type.String({ pattern: '^\\d{6}$' })),
})
const RefreshBody = Type.Object({
  refreshToken: Type.String({ minLength: 20 }),
  deviceId: Type.String({ format: 'uuid' }),
})

export function createAuthRoutes(
  config: AppConfig,
  auth: AuthService,
  tokens: TokenService,
): FastifyPluginAsyncTypebox {
  return async function authRoutes(app) {
    app.get('/v1/account', {
      schema: {
        response: {
          200: Type.Object({
            id: Type.String({ format: 'uuid' }),
            login: Type.String(),
            isAdmin: Type.Boolean(),
            totpEnabled: Type.Boolean(),
          }),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return auth.getAccount(claims.accountId)
    })

    app.post('/v1/auth/register', {
      config: { rateLimit: {
        max: 5, timeWindow: '1 minute',
        keyGenerator: (request) => loginRateKey(request.ip, request.body),
      } },
      schema: {
        headers: Type.Object({ 'x-setup-token': Type.Optional(Type.String()) }),
        body: SessionBody,
        response: { 201: SessionResponse },
      },
    }, async (request, reply) => {
      if (config.registrationMode !== 'open' && !safeEqual(request.headers['x-setup-token'], config.setupToken)) {
        throw new ApiError({ code: 'registration_closed', message: 'Registration is closed', statusCode: 403 })
      }
      return reply.status(201).send(await auth.register(request.body))
    })

    app.post('/v1/auth/login', {
      config: { rateLimit: {
        max: 10, timeWindow: '1 minute',
        keyGenerator: (request) => loginRateKey(request.ip, request.body),
      } },
      schema: { body: SessionBody, response: { 200: SessionResponse } },
    }, async (request) => auth.login(request.body))

    app.post('/v1/auth/refresh', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: RefreshBody, response: { 200: SessionResponse } },
    }, async (request) => auth.refresh(request.body.refreshToken, request.body.deviceId))

    app.post('/v1/auth/logout', {
      schema: { body: RefreshBody, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      await auth.logout(request.body.refreshToken, request.body.deviceId)
      return reply.status(204).send(null)
    })

    app.get('/v1/devices', {
      schema: {
        response: {
          200: Type.Array(Type.Object({
            id: Type.String({ format: 'uuid' }),
            name: Type.String(),
            platform: Type.String(),
            encryptionPublicKey: Type.Union([Type.String(), Type.Null()]),
            lastSeenAt: Timestamp,
            createdAt: Timestamp,
            revokedAt: NullableTimestamp,
            current: Type.Boolean(),
          })),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return auth.listDevices(claims.accountId, claims.deviceId)
    })

    app.put('/v1/auth/password', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({
          currentPassword: Type.String({ minLength: 8, maxLength: 1_024 }),
          newPassword: Type.String({ minLength: 8, maxLength: 1_024 }),
        }),
        response: { 200: SessionResponse },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return auth.changePassword(
        claims.accountId, claims.deviceId, request.body.currentPassword, request.body.newPassword,
      )
    })

    app.delete('/v1/account', {
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
      schema: {
        body: Type.Object({
          password: Type.String({ minLength: 8, maxLength: 1_024 }),
          confirmation: Type.Literal('DELETE'),
        }),
        response: { 202: Type.Object({ purgeAfter: Timestamp }) },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      const purgeAfter = await auth.requestAccountDeletion(
        claims.accountId, request.body.password, config.tombstoneRetentionDays,
      )
      return reply.status(202).send({ purgeAfter })
    })

    app.delete('/v1/devices/:deviceId', {
      schema: { params: Type.Object({ deviceId: Type.String({ format: 'uuid' }) }), response: { 204: Type.Null() } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await auth.revokeDevice(claims.accountId, request.params.deviceId)
      return reply.status(204).send(null)
    })

    app.patch('/v1/devices/:deviceId', {
      schema: {
        params: Type.Object({ deviceId: Type.String({ format: 'uuid' }) }),
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }) }),
        response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await auth.renameDevice(claims.accountId, request.params.deviceId, request.body.name)
      return reply.status(204).send(null)
    })
  }
}

function safeEqual(value: string | undefined, expected: string): boolean {
  if (value === undefined) return false
  const left = Buffer.from(value)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function loginRateKey(ip: string, body: unknown): string {
  const login = typeof body === 'object' && body !== null && 'login' in body && typeof body.login === 'string'
    ? body.login.trim().toLowerCase()
    : 'unknown'
  return `${ip}:${login}`
}
