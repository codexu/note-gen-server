import { createHmac } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyReply } from 'fastify'
import { type Static, Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import { isAllowedDevelopmentWebOrigin } from '../development-origin.js'
import { ApiError } from '../errors.js'
import type { AuthService } from '../auth/service.js'
import type { WebAccountSession, WebSessionService } from '../auth/web-session-service.js'
import type { AdminService } from '../admin/service.js'
import type { DeploymentService } from '../deployment/service.js'
import type { RiskService } from '../risk/service.js'
import { CounterString, NullableTimestamp, Timestamp } from './api-schemas.js'

export const WEB_SESSION_COOKIE = 'notegen_session'
export const WEB_CSRF_COOKIE = 'notegen_csrf'

const CredentialsBody = Type.Object({
  login: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
  password: Type.String({ minLength: 8, maxLength: 1_024 }),
  totpCode: Type.Optional(Type.String({ pattern: '^\\d{6}$' })),
})
const AccountResponse = Type.Object({
  account: Type.Object({
    id: Type.String({ format: 'uuid' }),
    login: Type.String(),
      isAdmin: Type.Boolean(),
      totpEnabled: Type.Boolean(),
  }),
})

export function createWebAuthRoutes(
  config: AppConfig,
  auth: AuthService,
  webSessions: WebSessionService,
  admin?: AdminService,
  deployment?: DeploymentService,
  risk?: RiskService,
): FastifyPluginAsyncTypebox {
  return async function webAuthRoutes(app) {
    app.post('/v1/web/auth/register', {
      config: { rateLimit: {
        max: 5, timeWindow: '1 minute',
        keyGenerator: (request) => loginRateKey(config.authSecret, request.ip, request.body),
      } },
      schema: {
        body: CredentialsBody,
        response: { 201: AccountResponse },
      },
    }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      // Hosted identities have an email-verification lifecycle and must use
      // the dedicated flow. A persisted policy mistake must not reopen this
      // generic username/password endpoint merely because it says public.
      if (config.deploymentMode === 'hosted') {
        throw new ApiError({
          code: 'email_registration_required', message: 'Hosted registration must use email verification', statusCode: 403,
        })
      }
      if (deployment?.canRegisterNormally() !== true) {
        throw new ApiError({ code: 'registration_closed', message: 'Registration is closed', statusCode: 403 })
      }
      try {
        await risk?.enforceIdentityAttempt({ action: 'registration', ip: request.ip, login: request.body.login })
        const account = await auth.registerAccount(request.body.login, request.body.password)
        const session = await webSessions.create(account.id, sessionContext(request))
        setSessionCookies(config, reply, session)
        await recordWebAuthRiskEvent(risk, request, 'authentication.registration', 'allowed', undefined, account.id)
        return reply.status(201).send({ account })
      } catch (error) {
        await recordWebAuthRiskEvent(risk, request, 'authentication.registration', 'rejected', error, undefined)
        throw error
      }
    })

    app.post('/v1/web/auth/login', {
      config: { rateLimit: {
        max: 10, timeWindow: '1 minute',
        keyGenerator: (request) => loginRateKey(config.authSecret, request.ip, request.body),
      } },
      schema: { body: CredentialsBody, response: { 200: AccountResponse } },
    }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      try {
        await risk?.enforceIdentityAttempt({ action: 'login', ip: request.ip, login: request.body.login })
        const account = await auth.authenticateAccount(request.body.login, request.body.password, request.body.totpCode)
        const session = await webSessions.create(account.id, sessionContext(request), account.credentialEpoch)
        setSessionCookies(config, reply, session)
        await recordWebAuthRiskEvent(risk, request, 'authentication.login', 'allowed', undefined, account.id)
        return { account }
      } catch (error) {
        await recordWebAuthRiskEvent(risk, request, 'authentication.login', 'rejected', error, undefined)
        throw error
      }
    })

    app.get('/v1/web/session', {
      schema: { response: { 200: AccountResponse } },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return { account: await auth.getAccount(session.accountId) }
    })

    app.post('/v1/web/auth/logout', { schema: { response: { 204: Type.Null() } } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await webSessions.destroy(request.cookies[WEB_SESSION_COOKIE])
      clearSessionCookies(config, reply)
      return reply.status(204).send(null)
    })

    app.put('/v1/web/auth/password', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({
          currentPassword: Type.String({ minLength: 8, maxLength: 1_024 }),
          newPassword: Type.String({ minLength: 8, maxLength: 1_024 }),
        }),
        response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await auth.changeWebPassword(session.accountId, request.body.currentPassword, request.body.newPassword)
      await webSessions.destroyForAccount(session.accountId)
      const nextSession = await webSessions.create(session.accountId, sessionContext(request))
      setSessionCookies(config, reply, nextSession)
      await admin?.recordAudit(session.accountId, 'account.password-change', 'account', session.accountId)
        .catch((error: unknown) => request.log.warn({ err: error }, 'Failed to record password change audit'))
      return reply.status(204).send(null)
    })

    app.get('/v1/web/devices', { schema: { response: { 200: Type.Array(Type.Object({
      id: Type.String({ format: 'uuid' }), name: Type.String(), platform: Type.String(),
      encryptionPublicKey: Type.Union([Type.String(), Type.Null()]), lastSeenAt: Timestamp,
      createdAt: Timestamp, revokedAt: NullableTimestamp, current: Type.Boolean(),
      syncStatus: Type.Union([Type.Literal('caught-up'), Type.Literal('behind'), Type.Literal('never-acknowledged')]),
      pendingEventCount: CounterString, acknowledgedAt: NullableTimestamp,
    })) } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return auth.listDevices(session.accountId)
    })

    app.get('/v1/web/sessions', { schema: { response: { 200: Type.Array(Type.Object({
      id: Type.String({ format: 'uuid' }), expiresAt: Timestamp, lastSeenAt: Timestamp,
      lastIp: Type.Union([Type.String(), Type.Null()]), userAgent: Type.Union([Type.String(), Type.Null()]),
      createdAt: Timestamp, current: Type.Boolean(),
    })) } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return webSessions.listForAccount(session.accountId, session.sessionId)
    })

    app.post('/v1/web/auth/totp/setup', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({ currentPassword: Type.String({ minLength: 8, maxLength: 1_024 }) }),
        response: { 200: Type.Object({ secret: Type.String(), uri: Type.String() }) },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return auth.beginTotpSetup(session.accountId, request.body.currentPassword)
    })

    app.post('/v1/web/auth/totp/enable', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({ code: Type.String({ pattern: '^\\d{6}$' }) }), response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await auth.enableTotp(session.accountId, request.body.code)
      return reply.status(204).send(null)
    })

    app.delete('/v1/web/auth/totp', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({
          currentPassword: Type.String({ minLength: 8, maxLength: 1_024 }),
          code: Type.String({ pattern: '^\\d{6}$' }),
        }),
        response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await auth.disableTotp(session.accountId, request.body.currentPassword, request.body.code)
      return reply.status(204).send(null)
    })

    app.delete('/v1/web/sessions/others', { schema: {
      response: { 200: Type.Object({ revoked: Type.Integer() }) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return { revoked: await webSessions.destroyOthers(session.accountId, session.sessionId) }
    })

    app.delete('/v1/web/account', {
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
      schema: {
        body: Type.Object({
          password: Type.String({ minLength: 8, maxLength: 1_024 }),
          confirmation: Type.Literal('DELETE'),
        }),
        response: { 202: Type.Object({ purgeAfter: Timestamp }) },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      const purgeAfter = await auth.requestAccountDeletion(
        session.accountId, request.body.password, config.tombstoneRetentionDays,
      )
      await webSessions.destroyForAccount(session.accountId)
      clearSessionCookies(config, reply)
      await admin?.recordAudit(session.accountId, 'account.deletion-request', 'account', session.accountId)
        .catch((error: unknown) => request.log.warn({ err: error }, 'Failed to record account deletion request'))
      return reply.status(202).send({ purgeAfter })
    })

    app.delete('/v1/web/devices/:deviceId', {
      schema: {
        params: Type.Object({ deviceId: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await auth.revokeDevice(session.accountId, request.params.deviceId)
      await admin?.recordAudit(session.accountId, 'device.revoke', 'device', request.params.deviceId)
        .catch((error: unknown) => request.log.warn({ err: error }, 'Failed to record device revocation audit'))
      return reply.status(204).send(null)
    })
  }
}

async function recordWebAuthRiskEvent(
  risk: RiskService | undefined,
  request: { body: Static<typeof CredentialsBody>, id: string, ip: string, headers: Record<string, string | string[] | undefined>, log: { warn: (value: unknown, message: string) => void } },
  eventType: 'authentication.login' | 'authentication.registration',
  outcome: 'allowed' | 'rejected',
  error: unknown,
  accountId: string | undefined,
): Promise<void> {
  if (risk === undefined) return
  await risk.recordEvent({
    eventType, login: request.body.login, requestId: request.id, ip: request.ip,
    ...(typeof request.headers['user-agent'] === 'string' ? { userAgent: request.headers['user-agent'] } : {}),
    ...(accountId === undefined ? {} : { accountId }),
    outcome,
    ...(error instanceof ApiError ? { reasonCode: error.code } : {}),
  }).catch((auditError: unknown) => request.log.warn({ err: auditError }, 'Failed to record authentication risk event'))
}

export async function requireWebSession(
  token: string | undefined,
  webSessions: WebSessionService,
): Promise<WebAccountSession> {
  return webSessions.authenticate(token)
}

export function requireCsrf(
  header: string | string[] | undefined,
  cookie: string | undefined,
  session: WebAccountSession,
  webSessions: WebSessionService,
): void {
  webSessions.verifyCsrf(session, cookie, typeof header === 'string' ? header : undefined)
}

export function setSessionCookies(
  config: AppConfig,
  reply: FastifyReply,
  session: { sessionToken: string; csrfToken: string; expiresAt: Date },
): void {
  const common = {
    path: '/',
    sameSite: 'strict',
    secure: config.publicBaseUrl.startsWith('https://') || config.webPublicBaseUrl.startsWith('https://'),
    expires: session.expiresAt,
  } as const
  reply.setCookie(WEB_SESSION_COOKIE, session.sessionToken, { ...common, httpOnly: true })
  reply.setCookie(WEB_CSRF_COOKIE, session.csrfToken, { ...common, httpOnly: false })
}

function clearSessionCookies(
  config: AppConfig,
  reply: FastifyReply,
): void {
  const options = {
    path: '/',
    secure: config.publicBaseUrl.startsWith('https://') || config.webPublicBaseUrl.startsWith('https://'),
    sameSite: 'strict',
  } as const
  reply.clearCookie(WEB_SESSION_COOKIE, options)
  reply.clearCookie(WEB_CSRF_COOKIE, options)
}

export function assertTrustedOrigin(config: AppConfig, origin: string | undefined): void {
  if (origin === undefined) return
  if (origin !== config.publicBaseUrl
    && origin !== config.webPublicBaseUrl
    && !config.corsOrigins.includes(origin)
    && !isAllowedDevelopmentWebOrigin(config, origin)) {
    throw new ApiError({ code: 'origin_not_allowed', message: 'Request origin is not allowed', statusCode: 403 })
  }
}

export function sessionContext(request: { ip: string, headers: { 'user-agent'?: string | undefined } }) {
  return { ip: request.ip, ...(request.headers['user-agent'] === undefined ? {} : { userAgent: request.headers['user-agent'] }) }
}

function loginRateKey(secret: string, ip: string, body: unknown): string {
  const login = typeof body === 'object' && body !== null && 'login' in body && typeof body.login === 'string'
    ? body.login.trim().toLowerCase()
    : 'unknown'
  return `v1:${createHmac('sha256', secret).update(`auth-rate-key:${ip}:${login}`).digest('base64url')}`
}
