import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { RiskService } from '../risk/service.js'
import type { StaffSessionService } from '../staff/session-service.js'
import { ApiError } from '../errors.js'

const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const headers = Type.Object({ 'x-staff-session-id': Type.String({ minLength: 36, maxLength: 36 }) })
const scope = Type.Union([Type.Literal('sync_write'), Type.Literal('blob'), Type.Literal('authentication'), Type.Literal('registration'), Type.Literal('recovery'), Type.Literal('device'), Type.Literal('billing'), Type.Literal('all')])
const action = Type.Union([Type.Literal('deny'), Type.Literal('challenge'), Type.Literal('lock'), Type.Literal('read_only'), Type.Literal('review')])

export function createStaffRiskRoutes(risk: RiskService, sessions: StaffSessionService): FastifyPluginAsyncTypebox {
  return async function staffRiskRoutes(app) {
    app.get('/v1/internal/staff/risk/accounts/:accountId/restrictions', { schema: { headers, params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }) } }, async request => {
      await requireStaffSession(request.headers['x-staff-session-id'], sessions, 'risk.read')
      return await risk.getActiveRestrictions(request.params.accountId)
    })
    app.post('/v1/internal/staff/risk/accounts/:accountId/restrictions', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } }, schema: { headers, params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }), body: Type.Object({ scope, action, reasonCode: Type.String({ minLength: 3, maxLength: 100, pattern: '^[a-z0-9._-]+$' }), expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]) }), response: { 201: Type.Object({ id: Type.String({ format: 'uuid' }), created: Type.Boolean() }) } } }, async (request, reply) => {
      const highImpact = request.body.action === 'deny' || request.body.action === 'lock' || request.body.expiresAt === null
      const session = highImpact
        ? await requireHighAssuranceStaffSession(request.headers['x-staff-session-id'], sessions, 'risk.manage')
        : await requireStaffSession(request.headers['x-staff-session-id'], sessions, 'risk.manage')
      const expiresAt = request.body.expiresAt === null ? null : new Date(request.body.expiresAt)
      return reply.status(201).send(await risk.upsertStaffAccountRestriction({ ...request.body, accountId: request.params.accountId, expiresAt, actorStaffId: session.staffId, requestId: request.id }))
    })
    app.delete('/v1/internal/staff/risk/restrictions/:restrictionId', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } }, schema: { headers, params: Type.Object({ restrictionId: Type.String({ format: 'uuid' }) }) } }, async (request, reply) => {
      // The service determines whether the existing restriction is high
      // impact; use high assurance for all revocations so a route cannot race
      // a stricter source/action decision made under its transaction lock.
      const session = await requireHighAssuranceStaffSession(request.headers['x-staff-session-id'], sessions, 'risk.manage')
      await risk.revokeStaffAccountRestriction({ actorStaffId: session.staffId, restrictionId: request.params.restrictionId, requestId: request.id })
      return reply.status(204).send()
    })
  }
}

async function requireStaffSession(value: string | string[] | undefined, sessions: StaffSessionService, permission: 'risk.read' | 'risk.manage') {
  if (typeof value !== 'string' || !sessionId.test(value)) throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session is unavailable', statusCode: 401 })
  return await sessions.requireActiveSession(value, permission)
}

async function requireHighAssuranceStaffSession(value: string | string[] | undefined, sessions: StaffSessionService, permission: 'risk.manage') {
  if (typeof value !== 'string' || !sessionId.test(value)) throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session is unavailable', statusCode: 401 })
  return await sessions.requireHighAssuranceSession(value, permission)
}
