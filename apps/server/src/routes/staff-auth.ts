import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyReply } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'
import type { StaffService } from '../staff/service.js'
import type { StaffSessionService } from '../staff/session-service.js'
import { assertTrustedOrigin } from './web-auth.js'

export const STAFF_SESSION_COOKIE = 'notegen_staff_session'
export const STAFF_CSRF_COOKIE = 'notegen_staff_csrf'

const StaffProfile = Type.Object({
  staff: Type.Object({
    id: Type.String({ format: 'uuid' }),
    login: Type.String(),
    displayName: Type.String(),
    roles: Type.Array(Type.String()),
    permissions: Type.Array(Type.String()),
  }),
})

/** Internal-test local Staff login. Production Staff authentication remains OIDC-only. */
export function createStaffAuthRoutes(
  config: AppConfig,
  staff: StaffService,
  sessions: StaffSessionService,
): FastifyPluginAsyncTypebox {
  return async function staffAuthRoutes(app) {
    app.post('/v1/staff/auth/login', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({
          login: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
          password: Type.String({ minLength: 8, maxLength: 1_024 }),
        }),
        response: { 200: StaffProfile },
      },
    }, async (request, reply) => {
      assertLocalStaffAuthAvailable(config)
      assertTrustedOrigin(config, request.headers.origin)
      const principal = await staff.authenticateLocal(request.body.login, request.body.password)
      const session = await sessions.establishLocalSession(principal.id)
      setStaffCookies(config, reply, session)
      return { staff: await staff.profile(principal.id) }
    })

    app.get('/v1/staff/session', { schema: { response: { 200: StaffProfile } } }, async (request) => {
      assertLocalStaffAuthAvailable(config)
      const session = await requireStaffCookieSession(request.cookies[STAFF_SESSION_COOKIE], sessions)
      return { staff: await staff.profile(session.staffId) }
    })

    app.post('/v1/staff/auth/logout', { schema: { response: { 204: Type.Null() } } }, async (request, reply) => {
      assertLocalStaffAuthAvailable(config)
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireStaffCookieSession(request.cookies[STAFF_SESSION_COOKIE], sessions)
      sessions.verifyCsrf(session, request.cookies[STAFF_CSRF_COOKIE], request.headers['x-csrf-token'])
      await sessions.revokeSession(session.sessionId)
      clearStaffCookies(config, reply)
      return reply.status(204).send(null)
    })
  }
}

function assertLocalStaffAuthAvailable(config: AppConfig): void {
  if (config.deploymentMode !== 'hosted' || config.hostedReleaseStage !== 'internal-test') {
    throw new ApiError({ code: 'staff_local_auth_unavailable', message: 'Local Staff authentication is unavailable', statusCode: 404 })
  }
}

async function requireStaffCookieSession(value: string | undefined, sessions: StaffSessionService) {
  if (value === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session is unavailable', statusCode: 401 })
  }
  return sessions.requireActiveSession(value)
}

function setStaffCookies(
  config: AppConfig,
  reply: FastifyReply,
  session: { sessionId: string, csrfToken: string, expiresAt: Date },
): void {
  const common = {
    path: '/',
    sameSite: 'strict',
    secure: config.publicBaseUrl.startsWith('https://') || config.webPublicBaseUrl.startsWith('https://'),
    expires: session.expiresAt,
  } as const
  reply.setCookie(STAFF_SESSION_COOKIE, session.sessionId, { ...common, httpOnly: true })
  reply.setCookie(STAFF_CSRF_COOKIE, session.csrfToken, { ...common, httpOnly: false })
}

function clearStaffCookies(config: AppConfig, reply: FastifyReply): void {
  const options = {
    path: '/',
    sameSite: 'strict',
    secure: config.publicBaseUrl.startsWith('https://') || config.webPublicBaseUrl.startsWith('https://'),
  } as const
  reply.clearCookie(STAFF_SESSION_COOKIE, options)
  reply.clearCookie(STAFF_CSRF_COOKIE, options)
}
