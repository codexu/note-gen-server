import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { SupportService } from '../support/service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import { requireCsrf, requireWebSession, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE } from './web-auth.js'

const Category = Type.Union([Type.Literal('account'), Type.Literal('sync'), Type.Literal('device'), Type.Literal('encryption'), Type.Literal('billing'), Type.Literal('privacy'), Type.Literal('abuse'), Type.Literal('other')])
const Severity = Type.Union([Type.Literal('normal'), Type.Literal('high'), Type.Literal('urgent')])

export function createSupportRoutes(support: SupportService, webSessions: WebSessionService): FastifyPluginAsyncTypebox {
  return async function supportRoutes(app) {
    app.post('/v1/web/support/cases', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } }, schema: { body: Type.Object({ category: Category, severity: Severity, subject: Type.String({ minLength: 1, maxLength: 200 }), body: Type.String({ minLength: 1, maxLength: 10_000 }), idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }) }) } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions); requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return reply.status(201).send(await support.createCase({ accountId: session.accountId, ...request.body }))
    })
    app.get('/v1/web/support/cases', async request => { const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions); return await support.listCases(session.accountId) })
    app.get('/v1/web/support/cases/:id', { schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } }, async request => { const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions); return await support.getCase(session.accountId, request.params.id) })
    app.post('/v1/web/support/cases/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } }, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 10_000 }), idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }) }) } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions); requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return reply.status(201).send(await support.appendCustomerMessage(session.accountId, request.params.id, request.body.body, request.body.idempotencyKey))
    })
    const Summary = Type.Object({ formatVersion: Type.Literal(1), phase: Type.String({ maxLength: 100 }), pauseReason: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]), server: Type.Object({ configured: Type.Boolean(), deploymentMode: Type.Union([Type.Literal('hosted'), Type.Literal('self-hosted'), Type.Null()]), serverVersion: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]), syncEpochKnown: Type.Boolean() }), queue: Type.Object({ pendingMutations: Type.Integer({ minimum: 0 }), pendingOutbox: Type.Integer({ minimum: 0 }), blockedOutbox: Type.Integer({ minimum: 0 }), pendingInbox: Type.Integer({ minimum: 0 }), failedInbox: Type.Integer({ minimum: 0 }), unresolvedConflicts: Type.Integer({ minimum: 0 }), pendingTransfers: Type.Integer({ minimum: 0 }), failedTransfers: Type.Integer({ minimum: 0 }) }) })
    app.post('/v1/web/support/cases/:id/diagnostics', { schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: Type.Object({ summary: Summary, expiresAt: Type.String({ format: 'date-time' }) }) } }, async (request, reply) => { const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions); requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions); return reply.status(201).send(await support.createDiagnosticGrant(session.accountId, request.params.id, request.body.summary, new Date(request.body.expiresAt))) })
    app.delete('/v1/web/support/cases/:id/diagnostics/:grantId', { schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }), grantId: Type.String({ format: 'uuid' }) }), response: { 204: Type.Null() } } }, async (request, reply) => { const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions); requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions); await support.revokeDiagnosticGrant(session.accountId, request.params.id, request.params.grantId); return reply.status(204).send(null) })
  }
}
