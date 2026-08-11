import { createHash } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { EntitlementService } from '../billing/service.js'
import type { StaffSessionService } from '../staff/session-service.js'
import { ApiError } from '../errors.js'

const STAFF_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const headers = Type.Object({ 'x-staff-session-id': Type.String({ minLength: 36, maxLength: 36 }) })

/** Internal-test manual entitlement grants. This route has no payment or
 * provider side effects and only delegates to the Staff-authorized domain service. */
export function createStaffBillingRoutes(entitlements: EntitlementService, sessions: StaffSessionService): FastifyPluginAsyncTypebox {
  return async function staffBillingRoutes(app) {
    app.post('/v1/internal/staff/billing/accounts/:accountId/grants', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } }, schema: { headers, params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }), body: Type.Object({ sourceRef: Type.String({ minLength: 3, maxLength: 200 }), expiresAt: Type.String({ format: 'date-time' }), entitlements: Type.Object({ features: Type.Optional(Type.Record(Type.String(), Type.Boolean())), limits: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }), Type.Integer({ minimum: 0 }), Type.Null()]))) }), priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) }), response: { 201: Type.Object({ id: Type.String({ format: 'uuid' }), created: Type.Boolean() }) } } }, async (request, reply) => {
      const session = await requireStaffSession(request.headers['x-staff-session-id'], sessions)
      const expiresAt = new Date(request.body.expiresAt)
      if (!Number.isFinite(expiresAt.getTime())) throw new ApiError({ code: 'billing_grant_expiry_invalid', message: 'Grant expiry is invalid', statusCode: 400 })
      const requestHash = createHash('sha256').update(JSON.stringify(request.body)).digest('base64url')
      return reply.status(201).send(await entitlements.createInternalGrant({
        accountId: request.params.accountId, sourceRef: request.body.sourceRef, requestHash,
        entitlements: request.body.entitlements, expiresAt, priority: request.body.priority, reason: request.body.reason,
        actorStaffId: session.staffId, requestId: request.id,
      }))
    })
  }
}

async function requireStaffSession(value: string | string[] | undefined, sessions: StaffSessionService) {
  if (typeof value !== 'string' || !STAFF_SESSION_ID.test(value)) {
    throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session is unavailable', statusCode: 401 })
  }
  return await sessions.requireActiveSession(value, 'billing.grant')
}
