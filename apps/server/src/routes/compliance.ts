import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { ComplianceService } from '../compliance/service.js'
import type { DeletionService } from '../compliance/deletion-service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import type { WebStepUpService } from '../step-up/service.js'
import type { AppConfig } from '../config.js'
import { assertTrustedOrigin, requireCsrf, requireWebSession, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE } from './web-auth.js'
import { NullableTimestamp, Timestamp } from './api-schemas.js'

const PolicyType = Type.Union([Type.Literal('terms'), Type.Literal('privacy'), Type.Literal('data_processing'), Type.Literal('cookie')])
const DataRequestType = Type.Union([Type.Literal('access'), Type.Literal('export'), Type.Literal('correct'), Type.Literal('delete'), Type.Literal('restrict'), Type.Literal('object')])

export function createComplianceRoutes(config: AppConfig, compliance: ComplianceService, webSessions: WebSessionService, deletion?: DeletionService, stepUps?: WebStepUpService): FastifyPluginAsyncTypebox {
  return async function complianceRoutes(app) {
    app.get('/v1/web/policies/current', { schema: { querystring: Type.Object({ locale: Type.Optional(Type.String({ minLength: 2, maxLength: 20 })) }), response: { 200: Type.Array(Type.Object({ id: Type.String({ format: 'uuid' }), type: PolicyType, version: Type.String(), contentRef: Type.String(), contentHash: Type.String(), effectiveAt: Timestamp, requiresReacceptance: Type.Boolean() })) } } }, async (request) => {
      return await compliance.listCurrentDocuments(request.query.locale ?? 'en')
    })

    app.post('/v1/web/policies/:id/accept', { schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: Type.Object({ subjectSnapshot: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }), response: { 201: Type.Object({ id: Type.String() }) } } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      const accepted = await compliance.recordAcceptance({ accountId: session.accountId, policyDocumentId: request.params.id, subjectSnapshot: request.body.subjectSnapshot ?? {} })
      return reply.status(201).send({ id: accepted.id.toString() })
    })

    app.post('/v1/web/account/data-requests', { schema: { body: Type.Object({ type: DataRequestType, idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }) }), response: { 202: Type.Object({ id: Type.String({ format: 'uuid' }), created: Type.Boolean(), status: Type.String() }) } } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      const created = await compliance.createDataRequest({ accountId: session.accountId, clientIdempotencyKey: request.body.idempotencyKey, type: request.body.type, requestChannel: 'web-internal-test' })
      return reply.status(202).send(created)
    })

    app.get('/v1/web/account/data-requests', { schema: { response: { 200: Type.Array(Type.Object({ id: Type.String({ format: 'uuid' }), type: DataRequestType, status: Type.String(), dueAt: NullableTimestamp, completedAt: NullableTimestamp, createdAt: Timestamp })) } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return await compliance.listDataRequests(session.accountId)
    })

    if (deletion !== undefined) {
      app.post('/v1/web/account/deletion', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } }, schema: { headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }), body: Type.Object({ password: Type.String({ minLength: 8, maxLength: 1_024 }), confirmation: Type.Literal('DELETE') }), response: { 202: Type.Object({ caseId: Type.String({ format: 'uuid' }), status: Type.Union([Type.Literal('cooling_off'), Type.Literal('held')]), cancelUntil: Timestamp, purgeAfter: Timestamp, cancelToken: Type.String() }) } } }, async (request, reply) => {
        assertTrustedOrigin(config, request.headers.origin)
        const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
        requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
        if (stepUps !== undefined) await stepUps.consumeAccountGrant({ token: request.headers['x-step-up-token'], accountId: session.accountId, sessionId: session.sessionId, audience: 'account.deletion.request', requestHash: stepUps.requestHash({ confirmation: request.body.confirmation }) })
        return reply.status(202).send(await deletion.request(session.accountId, request.body.password))
      })
      app.post('/v1/web/account/deletion/cancel', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } }, schema: { body: Type.Object({ caseId: Type.String({ format: 'uuid' }), token: Type.String({ minLength: 20, maxLength: 512 }) }), response: { 200: Type.Object({ status: Type.Literal('canceled') }) } } }, async (request) => deletion.cancel(request.body.caseId, request.body.token))
    }
  }
}
