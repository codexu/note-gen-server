import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { ApiError } from '../errors.js'
import type { StaffService } from '../staff/service.js'
import type { StaffSessionService } from '../staff/session-service.js'
import type { SupportService } from '../support/service.js'
import { STAFF_SESSION_COOKIE } from './staff-auth.js'
import { NullableTimestamp, Timestamp } from './api-schemas.js'

const nullableString = Type.Union([Type.String(), Type.Null()])

export function createStaffOperationsRoutes(
  staff: StaffService,
  sessions: StaffSessionService,
  support?: SupportService,
): FastifyPluginAsyncTypebox {
  return async function staffOperationsRoutes(app) {
    app.get('/v1/staff/operations/overview', { schema: { response: { 200: Type.Object({
      accountCount: Type.Integer(), activeAccountCount: Type.Integer(), newAccountCount: Type.Integer(),
      activeSubscriptionCount: Type.Integer(), openSupportCaseCount: Type.Integer(), urgentSupportCaseCount: Type.Integer(),
      reviewRiskEventCount: Type.Integer(), pendingDataRequestCount: Type.Integer(), activeStaffSessionCount: Type.Integer(),
      generatedAt: Timestamp,
    }) } } }, async request => {
      const session = await requireStaffCookieSession(request.cookies[STAFF_SESSION_COOKIE], sessions)
      return await staff.getOperationsOverview(session.staffId)
    })

    app.get('/v1/staff/operations/accounts', { schema: {
      querystring: Type.Object({
        query: Type.Optional(Type.String({ maxLength: 200 })),
        status: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('active'), Type.Literal('suspended'), Type.Literal('disabled')])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      response: { 200: Type.Array(Type.Object({
        id: Type.String({ format: 'uuid' }), login: Type.String(), identityState: Type.String(),
        status: Type.String(), workspaceCount: Type.Integer(), deviceCount: Type.Integer(),
        subscriptionStatus: nullableString, createdAt: Timestamp,
      })) },
    } }, async request => {
      const session = await requireStaffCookieSession(request.cookies[STAFF_SESSION_COOKIE], sessions)
      return await staff.listOperationsAccounts(session.staffId, {
        query: request.query.query ?? '',
        status: request.query.status ?? 'all',
        limit: request.query.limit ?? 100,
      })
    })

    app.get('/v1/staff/operations/risk/events', { schema: {
      querystring: limitQuery,
      response: { 200: Type.Array(Type.Object({
        id: Type.String(), eventType: Type.String(), accountId: nullableString, accountLogin: nullableString,
        outcome: Type.String(), reasonCodes: Type.Array(Type.String()), score: Type.Union([Type.Integer(), Type.Null()]),
        createdAt: Timestamp,
      })) },
    } }, async request => {
      const session = await requireStaffCookieSession(request.cookies[STAFF_SESSION_COOKIE], sessions)
      return await staff.listOperationsRiskEvents(session.staffId, request.query.limit ?? 100)
    })

    app.get('/v1/staff/operations/billing/subscriptions', { schema: {
      querystring: limitQuery,
      response: { 200: Type.Array(Type.Object({
        id: Type.String({ format: 'uuid' }), accountId: nullableString, accountLogin: nullableString,
        provider: Type.String(), status: Type.String(), isCurrent: Type.Boolean(),
        currentPeriodEnd: NullableTimestamp, createdAt: Timestamp,
      })) },
    } }, async request => {
      const session = await requireStaffCookieSession(request.cookies[STAFF_SESSION_COOKIE], sessions)
      return await staff.listOperationsSubscriptions(session.staffId, request.query.limit ?? 100)
    })

    app.get('/v1/staff/operations/compliance/requests', { schema: {
      querystring: limitQuery,
      response: { 200: Type.Array(Type.Object({
        id: Type.String({ format: 'uuid' }), accountId: nullableString, accountLogin: nullableString,
        type: Type.String(), status: Type.String(), requestChannel: Type.String(),
        dueAt: NullableTimestamp, createdAt: Timestamp,
      })) },
    } }, async request => {
      const session = await requireStaffCookieSession(request.cookies[STAFF_SESSION_COOKIE], sessions)
      return await staff.listOperationsDataRequests(session.staffId, request.query.limit ?? 100)
    })

    if (support !== undefined) {
      app.get('/v1/staff/operations/support/cases', { schema: { response: { 200: Type.Array(Type.Object({
        id: Type.String({ format: 'uuid' }), category: Type.String(), severity: Type.String(), status: Type.String(),
        subject: Type.String(), assignedStaffId: nullableString, lastMessageAt: NullableTimestamp,
        createdAt: Timestamp, updatedAt: Timestamp,
      })) } } }, async request => {
        const session = await requireStaffCookieSession(request.cookies[STAFF_SESSION_COOKIE], sessions)
        return await support.listForStaff(session.staffId, request.id)
      })
    }
  }
}

const limitQuery = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) })

async function requireStaffCookieSession(value: string | undefined, sessions: StaffSessionService) {
  if (value === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session is unavailable', statusCode: 401 })
  }
  return await sessions.requireActiveSession(value)
}
