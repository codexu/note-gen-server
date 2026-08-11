import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import type { MailAdminService } from '../mail/admin-service.js'
import type { WebStepUpService } from '../step-up/service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import { assertTrustedOrigin, requireCsrf, requireWebSession, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE } from './web-auth.js'

export function createMailAdminRoutes(config: AppConfig, mail: MailAdminService, webSessions: WebSessionService, stepUps: WebStepUpService): FastifyPluginAsyncTypebox {
  return async function mailAdminRoutes(app) {
    app.get('/v1/web/admin/mail/status', { schema: { response: { 200: Type.Object({ configured: Type.Boolean(), health: Type.Union([Type.Literal('disabled'), Type.Literal('configured_unknown')]), queue: Type.Record(Type.String(), Type.Integer()) }) } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return await mail.getStatus(session.accountId)
    })
    app.post('/v1/web/admin/mail/test', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } }, schema: { headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }), body: Type.Object({ recipient: Type.String({ minLength: 3, maxLength: 320 }) }), response: { 202: Type.Object({ id: Type.String({ format: 'uuid' }), created: Type.Literal(true) }) } } }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await stepUps.consumeAccountGrant({ token: request.headers['x-step-up-token'], accountId: session.accountId, sessionId: session.sessionId, audience: 'mail.test.enqueue', requestHash: stepUps.requestHash({ recipient: request.body.recipient.trim().toLocaleLowerCase('und') }) })
      return reply.status(202).send(await mail.enqueueTest(session.accountId, request.body.recipient))
    })
    app.get('/v1/web/admin/mail/queue', { schema: { querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('sending'), Type.Literal('sent'), Type.Literal('dead_letter'), Type.Literal('delivery_unknown')])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), response: { 200: Type.Array(Type.Object({ id: Type.String({ format: 'uuid' }), template: Type.String(), status: Type.String(), attempts: Type.Integer(), maxAttempts: Type.Integer(), errorCode: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String({ format: 'date-time' }), nextAttemptAt: Type.String({ format: 'date-time' }) })) } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return await mail.listQueue(session.accountId, { status: request.query.status, limit: request.query.limit ?? 50 })
    })
    app.post('/v1/web/admin/mail/queue/:id/cancel', { schema: { headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }), params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 204: Type.Null() } } }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await stepUps.consumeAccountGrant({ token: request.headers['x-step-up-token'], accountId: session.accountId, sessionId: session.sessionId, audience: 'mail.queue.cancel', requestHash: stepUps.requestHash({ outboxId: request.params.id }) })
      await mail.cancelPending(session.accountId, request.params.id)
      return reply.status(204).send(null)
    })
    app.post('/v1/web/admin/mail/probe', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } }, schema: { headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }), body: Type.Object({}), response: { 200: Type.Object({ status: Type.Union([Type.Literal('healthy'), Type.Literal('degraded'), Type.Literal('misconfigured')]), checkedAt: Type.String({ format: 'date-time' }) }) } } }, async (request) => {
      assertTrustedOrigin(config, request.headers.origin)
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await stepUps.consumeAccountGrant({ token: request.headers['x-step-up-token'], accountId: session.accountId, sessionId: session.sessionId, audience: 'mail.health.probe', requestHash: stepUps.requestHash({}) })
      return await mail.probe(session.accountId)
    })
  }
}
