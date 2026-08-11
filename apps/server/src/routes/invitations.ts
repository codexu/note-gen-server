import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { InvitationService } from '../invitations/service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import type { AppConfig } from '../config.js'
import type { AuthService } from '../auth/service.js'
import type { WebStepUpService } from '../step-up/service.js'
import { assertTrustedOrigin, requireCsrf, requireWebSession, sessionContext, setSessionCookies, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE } from './web-auth.js'
import { ApiError } from '../errors.js'

const Invitation = Type.Object({
  id: Type.String({ format: 'uuid' }), tokenHint: Type.String(), expiresAt: Type.String({ format: 'date-time' }), revokedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  maxUses: Type.Integer(), useCount: Type.Integer(), note: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String({ format: 'date-time' }), paused: Type.Boolean(),
  delivery: Type.Union([Type.Null(), Type.Object({ status: Type.Union([Type.Literal('pending'), Type.Literal('sending'), Type.Literal('sent'), Type.Literal('dead_letter'), Type.Literal('delivery_unknown')]), errorCode: Type.Union([Type.String(), Type.Null()]) })]),
})

export function createInvitationRoutes(config: AppConfig, invitations: InvitationService, webSessions: WebSessionService, stepUps: WebStepUpService, auth: AuthService): FastifyPluginAsyncTypebox {
  return async function invitationRoutes(app) {
    app.post('/v1/invitations/inspect', { schema: { body: Type.Object({ token: Type.String({ minLength: 20, maxLength: 512 }) }), response: { 200: Type.Object({ canContinue: Type.Boolean(), requiresEmail: Type.Boolean(), serverName: Type.String() }) } } }, async (request) => invitations.inspect(request.body.token))
    app.post('/v1/web/auth/register/invitation', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { body: Type.Object({ token: Type.String({ minLength: 20, maxLength: 512 }), login: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }), password: Type.String({ minLength: 8, maxLength: 1024 }), email: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })) }), response: { 201: Type.Object({ account: Type.Object({ id: Type.String({ format: 'uuid' }), login: Type.String(), isAdmin: Type.Literal(false), totpEnabled: Type.Literal(false) }) }) } } }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const account = await invitations.accept({ ...request.body, requestId: request.id })
      const session = await webSessions.create(account.id, sessionContext(request))
      setSessionCookies(config, reply, session)
      return reply.status(201).send({ account })
    })
    app.post('/v1/web/auth/step-up', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { body: Type.Object({ audience: Type.Union([Type.Literal('registration.invitation.create'), Type.Literal('registration.invitation.revoke'), Type.Literal('registration.invitation.replace'), Type.Literal('registration.policy.update'), Type.Literal('runtime.configuration.update'), Type.Literal('account.deletion.request'), Type.Literal('mail.test.enqueue'), Type.Literal('mail.queue.cancel'), Type.Literal('mail.health.probe')]), requestHash: Type.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]{43}$' }), password: Type.String({ minLength: 8, maxLength: 1_024 }), totpCode: Type.Optional(Type.String({ pattern: '^\\d{6}$' }) ) }), response: { 201: Type.Object({ token: Type.String(), expiresAt: Type.String({ format: 'date-time' }) }) } } }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      const account = await auth.authenticateAccount(session.login, request.body.password, request.body.totpCode)
      if (account.id !== session.accountId) throw new ApiError({ code: 'web_session_invalid', message: 'Web session is invalid', statusCode: 401 })
      const grant = await stepUps.issueAccountGrant({ accountId: session.accountId, sessionId: session.sessionId, audience: request.body.audience, requestHash: request.body.requestHash, authMethods: request.body.totpCode === undefined ? ['password'] : ['password', 'totp'] })
      return reply.status(201).send({ token: grant.token, expiresAt: grant.expiresAt.toISOString() })
    })
    app.get('/v1/web/admin/invitations', { schema: { response: { 200: Type.Array(Invitation) } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return invitations.list(session.accountId)
    })
    app.post('/v1/web/admin/invitations', { schema: { headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }), body: Type.Object({ expiresAt: Type.String({ format: 'date-time' }), maxUses: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), note: Type.Optional(Type.String({ maxLength: 500 })), boundEmail: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })), send: Type.Optional(Type.Boolean()) }), response: { 201: Type.Object({ id: Type.String({ format: 'uuid' }), token: Type.String(), url: Type.String(), expiresAt: Type.String({ format: 'date-time' }), deliveryQueued: Type.Boolean() }) } } }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await stepUps.consumeAccountGrant({ token: request.headers['x-step-up-token'], accountId: session.accountId, sessionId: session.sessionId, audience: 'registration.invitation.create', requestHash: stepUps.requestHash({ expiresAt: request.body.expiresAt, maxUses: request.body.maxUses ?? 1, note: request.body.note?.trim() || null, boundEmail: request.body.boundEmail?.trim().toLowerCase() || null, send: request.body.send === true }) })
      const invitation = await invitations.create(session.accountId, { ...request.body, expiresAt: new Date(request.body.expiresAt) })
      return reply.status(201).send(invitation)
    })
    app.delete('/v1/web/admin/invitations/:id', { schema: { headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }), params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 204: Type.Null() } } }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await stepUps.consumeAccountGrant({ token: request.headers['x-step-up-token'], accountId: session.accountId, sessionId: session.sessionId, audience: 'registration.invitation.revoke', requestHash: stepUps.requestHash({ invitationId: request.params.id }) })
      await invitations.revoke(session.accountId, request.params.id)
      return reply.status(204).send(null)
    })
    app.post('/v1/web/admin/invitations/:id/replace-and-send', { schema: { headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }), params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 201: Type.Object({ id: Type.String({ format: 'uuid' }), expiresAt: Type.String({ format: 'date-time' }), deliveryQueued: Type.Literal(true) }) } } }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await stepUps.consumeAccountGrant({ token: request.headers['x-step-up-token'], accountId: session.accountId, sessionId: session.sessionId, audience: 'registration.invitation.replace', requestHash: stepUps.requestHash({ invitationId: request.params.id }) })
      return reply.status(201).send(await invitations.replaceAndSend(session.accountId, request.params.id))
    })
    app.put('/v1/web/admin/registration-policy', { schema: { headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }), body: Type.Object({ policy: Type.Union([Type.Literal('disabled'), Type.Literal('invitation'), Type.Literal('public')]) }), response: { 204: Type.Null() } } }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await stepUps.consumeAccountGrant({ token: request.headers['x-step-up-token'], accountId: session.accountId, sessionId: session.sessionId, audience: 'registration.policy.update', requestHash: stepUps.requestHash({ policy: request.body.policy }) })
      await invitations.setRegistrationPolicy(session.accountId, request.body.policy)
      return reply.status(204).send(null)
    })
  }
}
