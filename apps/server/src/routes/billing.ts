import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { EntitlementService } from '../billing/service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import { requireWebSession, WEB_SESSION_COOKIE } from './web-auth.js'

export function createBillingRoutes(entitlements: EntitlementService, webSessions: WebSessionService): FastifyPluginAsyncTypebox {
  return async function billingRoutes(app) {
    app.get('/v1/web/billing/plans', { schema: { response: { 200: Type.Array(Type.Object({ planKey: Type.String(), version: Type.Integer(), displayName: Type.String(), currency: Type.String(), amountMinor: Type.String(), interval: Type.Union([Type.Literal('month'), Type.Literal('year')]), entitlementSchemaVersion: Type.Integer() })) } } }, async () => await entitlements.listInternalPlans())
    app.get('/v1/web/billing/summary', { schema: { response: { 200: Type.Object({ schemaVersion: Type.Integer(), revision: Type.String(), source: Type.String(), validUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]), features: Type.Record(Type.String(), Type.Boolean()), limits: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])) }) } } }, async request => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return await entitlements.getEffective(session.accountId)
    })
  }
}
