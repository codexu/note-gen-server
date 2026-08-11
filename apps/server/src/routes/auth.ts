import { createHmac } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { type Static, Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'
import { requireAuth } from '../auth/http-auth.js'
import type { AuthService } from '../auth/service.js'
import type { TokenService } from '../auth/tokens.js'
import type { DeploymentService } from '../deployment/service.js'
import type { DeletionService } from '../compliance/deletion-service.js'
import type { RiskService } from '../risk/service.js'
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
  refreshRequestId: Type.Optional(Type.String({ format: 'uuid' })),
})

export function createAuthRoutes(
  config: AppConfig,
  auth: AuthService,
  tokens: TokenService,
  deployment: DeploymentService,
  deletion?: DeletionService,
  risk?: RiskService,
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
        keyGenerator: (request) => loginRateKey(config.authSecret, request.ip, request.body),
      } },
      schema: {
        headers: Type.Object({ 'x-setup-token': Type.Optional(Type.String()) }),
        body: SessionBody,
        response: { 201: SessionResponse },
      },
    }, async (request, reply) => {
      if (config.deploymentMode === 'hosted') {
        throw new ApiError({
          code: 'web_registration_required', message: 'Hosted registration must be completed in the account web flow', statusCode: 403,
          details: { actionUrl: config.webPublicBaseUrl },
        })
      }
      if (!deployment.canRegisterNormally()) {
        throw new ApiError({ code: 'registration_closed', message: 'Registration is closed', statusCode: 403 })
      }
      try {
        await risk?.enforceIdentityAttempt({ action: 'registration', ip: request.ip, login: request.body.login, deviceId: request.body.deviceId })
        const session = await auth.register(request.body)
        await recordAuthRiskEvent(risk, request, 'authentication.registration', 'allowed', undefined, session.accountId)
        return reply.status(201).send(session)
      } catch (error) {
        await recordAuthRiskEvent(risk, request, 'authentication.registration', 'rejected', error, undefined)
        throw error
      }
    })

    app.post('/v1/auth/login', {
      config: { rateLimit: {
        max: 10, timeWindow: '1 minute',
        keyGenerator: (request) => loginRateKey(config.authSecret, request.ip, request.body),
      } },
      schema: { body: SessionBody, response: { 200: SessionResponse } },
    }, async (request) => {
      try {
        await risk?.enforceIdentityAttempt({ action: 'login', ip: request.ip, login: request.body.login, deviceId: request.body.deviceId })
        const session = await auth.login(request.body)
        await recordAuthRiskEvent(risk, request, 'authentication.login', 'allowed', undefined, session.accountId)
        return session
      } catch (error) {
        await recordAuthRiskEvent(risk, request, 'authentication.login', 'rejected', error, undefined)
        throw error
      }
    })

    app.post('/v1/auth/refresh', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: RefreshBody, response: { 200: SessionResponse } },
    }, async (request) => auth.refresh(request.body.refreshToken, request.body.deviceId, request.body.refreshRequestId))

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
        response: { 202: Type.Object({ purgeAfter: Timestamp, caseId: Type.Optional(Type.String({ format: 'uuid' })), status: Type.Optional(Type.String()), cancelUntil: Type.Optional(Timestamp), cancelToken: Type.Optional(Type.String()) }) },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      if (deletion !== undefined) {
        const result = await deletion.request(claims.accountId, request.body.password)
        return reply.status(202).send(result)
      }
      const purgeAfter = await auth.requestAccountDeletion(claims.accountId, request.body.password, config.tombstoneRetentionDays)
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

async function recordAuthRiskEvent(
  risk: RiskService | undefined,
  request: { body: Static<typeof SessionBody>, id: string, ip: string, headers: { 'user-agent'?: string | string[] }, log: { warn: (value: unknown, message: string) => void } },
  eventType: 'authentication.login' | 'authentication.registration',
  outcome: 'allowed' | 'rejected',
  error: unknown,
  accountId: string | undefined,
): Promise<void> {
  if (risk === undefined) return
  const reasonCode = error instanceof ApiError ? error.code : undefined
  await risk.recordEvent({
    eventType, login: request.body.login, requestId: request.id, ip: request.ip,
    ...(typeof request.headers['user-agent'] === 'string' ? { userAgent: request.headers['user-agent'] } : {}),
    deviceId: request.body.deviceId, accountId, outcome, reasonCode,
  }).catch((auditError: unknown) => request.log.warn({ err: auditError }, 'Failed to record authentication risk event'))
}

function loginRateKey(secret: string, ip: string, body: unknown): string {
  const login = typeof body === 'object' && body !== null && 'login' in body && typeof body.login === 'string'
    ? body.login.trim().toLowerCase()
    : 'unknown'
  return `v1:${createHmac('sha256', secret).update(`auth-rate-key:${ip}:${login}`).digest('base64url')}`
}
