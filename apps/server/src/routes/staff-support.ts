import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { StaffSessionService } from '../staff/session-service.js'
import type { SupportService } from '../support/service.js'
import { ApiError } from '../errors.js'

const STAFF_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Internal staff edge. It never establishes a Staff session: a verified OIDC
 * assertion must first be exchanged by the separate staff identity edge for
 * the opaque session ID consumed here. Customer web sessions and accounts
 * cannot satisfy this boundary.
 */
export function createStaffSupportRoutes(support: SupportService, sessions: StaffSessionService): FastifyPluginAsyncTypebox {
  return async function staffSupportRoutes(app) {
    app.get('/v1/internal/staff/support/cases', { schema: { headers: staffHeaders, response: { 200: Type.Array(caseSummary) } } }, async request => {
      const session = await requireStaffSession(request.headers['x-staff-session-id'], sessions, 'support.read')
      return await support.listForStaff(session.staffId, request.id)
    })
    app.get('/v1/internal/staff/support/cases/:id', { schema: { headers: staffHeaders, params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 200: caseDetail } } }, async request => {
      const session = await requireStaffSession(request.headers['x-staff-session-id'], sessions, 'support.read')
      return await support.getForStaff(session.staffId, request.params.id, request.id)
    })
    app.post('/v1/internal/staff/support/cases/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } }, schema: { headers: staffHeaders, params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 10_000 }), idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }) }), response: { 201: Type.Object({ id: Type.String({ format: 'uuid' }), created: Type.Boolean() }) } } }, async (request, reply) => {
      const session = await requireStaffSession(request.headers['x-staff-session-id'], sessions, 'support.write')
      return reply.status(201).send(await support.appendStaffMessage(session.staffId, request.params.id, request.body.body, request.body.idempotencyKey, request.id))
    })
    app.post('/v1/internal/staff/support/cases/:id/notes', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } }, schema: { headers: staffHeaders, params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 10_000 }), idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }) }), response: { 201: Type.Object({ id: Type.String({ format: 'uuid' }), created: Type.Boolean() }) } } }, async (request, reply) => {
      const session = await requireStaffSession(request.headers['x-staff-session-id'], sessions, 'support.write')
      return reply.status(201).send(await support.appendStaffMessage(session.staffId, request.params.id, request.body.body, request.body.idempotencyKey, request.id, 'internal'))
    })
    app.put('/v1/internal/staff/support/cases/:id/assignment', { schema: { headers: staffHeaders, params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: Type.Object({ assigned: Type.Boolean() }), response: { 200: Type.Object({ assignedStaffId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]) }) } } }, async request => {
      const session = await requireStaffSession(request.headers['x-staff-session-id'], sessions, 'support.write')
      return await support.setOwnAssignment(session.staffId, request.params.id, request.body.assigned, request.id)
    })
    app.get('/v1/internal/staff/support/cases/:id/diagnostics/:grantId', { schema: { headers: staffHeaders, params: Type.Object({ id: Type.String({ format: 'uuid' }), grantId: Type.String({ format: 'uuid' }) }) } }, async request => {
      const session = await requireStaffSession(request.headers['x-staff-session-id'], sessions, 'support.diagnostics')
      return await support.getDiagnosticForStaff(session.staffId, request.params.id, request.params.grantId, request.id)
    })
  }
}

const staffHeaders = Type.Object({ 'x-staff-session-id': Type.String({ minLength: 36, maxLength: 36 }) })
const caseSummary = Type.Object({
  id: Type.String({ format: 'uuid' }), category: Type.String(), severity: Type.String(), status: Type.String(), subject: Type.String(),
  assignedStaffId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]), lastMessageAt: Type.String({ format: 'date-time' }),
  createdAt: Type.String({ format: 'date-time' }), updatedAt: Type.String({ format: 'date-time' }),
})
const caseDetail = Type.Intersect([caseSummary, Type.Object({ messages: Type.Array(Type.Object({
  id: Type.String({ format: 'uuid' }), authorType: Type.String(), visibility: Type.String(), body: Type.String(), createdAt: Type.String({ format: 'date-time' }),
})) })])

async function requireStaffSession(value: string | string[] | undefined, sessions: StaffSessionService, permission: 'support.read' | 'support.write' | 'support.diagnostics') {
  if (typeof value !== 'string' || !STAFF_SESSION_ID.test(value)) {
    throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session is unavailable', statusCode: 401 })
  }
  return await sessions.requireActiveSession(value, permission)
}
