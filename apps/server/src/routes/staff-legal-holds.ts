import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { LegalHoldService } from '../compliance/legal-hold-service.js'
import type { StaffSessionService } from '../staff/session-service.js'
import { ApiError } from '../errors.js'

const STAFF_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const headers = Type.Object({ 'x-staff-session-id': Type.String({ minLength: 36, maxLength: 36 }) })
const uuidParams = Type.Object({ accountId: Type.String({ format: 'uuid' }) })
const holdParams = Type.Object({ holdId: Type.String({ format: 'uuid' }) })
const body = Type.Object({ reasonCode: Type.String({ minLength: 3, maxLength: 100, pattern: '^[a-z0-9._-]+$' }) })

/** Internal-only Staff authority for the legal-hold service. Session creation
 * remains outside this route and requires a verified federated assertion. */
export function createStaffLegalHoldRoutes(holds: LegalHoldService, sessions: StaffSessionService): FastifyPluginAsyncTypebox {
  return async function staffLegalHoldRoutes(app) {
    app.post('/v1/internal/staff/compliance/accounts/:accountId/legal-holds', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } }, schema: { headers, params: uuidParams, body, response: { 201: Type.Object({ id: Type.String({ format: 'uuid' }), created: Type.Boolean() }) } } }, async (request, reply) => {
      const session = await requireHighAssuranceStaffSession(request.headers['x-staff-session-id'], sessions)
      return reply.status(201).send(await holds.place(request.params.accountId, session.staffId, request.body.reasonCode))
    })
    app.post('/v1/internal/staff/compliance/legal-holds/:holdId/release', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } }, schema: { headers, params: holdParams, body, response: { 204: Type.Null() } } }, async (request, reply) => {
      const session = await requireHighAssuranceStaffSession(request.headers['x-staff-session-id'], sessions)
      await holds.release(request.params.holdId, session.staffId, request.body.reasonCode)
      return reply.status(204).send(null)
    })
  }
}

async function requireHighAssuranceStaffSession(value: string | string[] | undefined, sessions: StaffSessionService) {
  if (typeof value !== 'string' || !STAFF_SESSION_ID.test(value)) {
    throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session is unavailable', statusCode: 401 })
  }
  return await sessions.requireHighAssuranceSession(value)
}
