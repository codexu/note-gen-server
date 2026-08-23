import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyReply } from 'fastify'
import { createReadStream } from 'node:fs'
import { once } from 'node:events'
import { Type } from '@sinclair/typebox'
import type { AdminService } from '../admin/service.js'
import type { AppConfig } from '../config.js'
import { capabilityIds, type CapabilityRegistry } from '../deployment/capabilities.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import type { WebStepUpService } from '../step-up/service.js'
import { NullableTimestamp, Timestamp } from './api-schemas.js'
import {
  requireCsrf, requireWebSession, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE,
} from './web-auth.js'

const AdminOverviewResponse = Type.Object({
  accountCount: Type.Integer(),
  activeAccountCount: Type.Integer(),
  workspaceCount: Type.Integer(),
  objectCount: Type.Integer(),
  deletedObjectCount: Type.Integer(),
  activeDeviceCount: Type.Integer(),
  auditCount: Type.Integer(),
})
const AdminSystemStatusResponse = Type.Object({
  status: Type.Literal('ok'), databaseLatencyMs: Type.Number(), uptimeSeconds: Type.Integer(),
  memoryRssBytes: Type.String(), heapUsedBytes: Type.String(), databaseBytes: Type.String(),
  blobCount: Type.Integer(), blobBytes: Type.String(), objectBytes: Type.String(),
  versionCount: Type.Integer(), changeCount: Type.Integer(), checkedAt: Timestamp,
})
const AdminSummaryResponse = Type.Object({
  serverVersion: Type.String(), generatedAt: Timestamp,
  overview: AdminOverviewResponse,
  system: AdminSystemStatusResponse,
  operations: Type.Object({
    activeJobs: Type.Integer(), failedJobs: Type.Integer(), pendingMail: Type.Integer(), failedMail: Type.Integer(),
    maintenanceMode: Type.String(), latestBackupStatus: Type.Union([Type.String(), Type.Null()]),
    latestBackupAt: NullableTimestamp, latestRestoreDrillStatus: Type.Union([Type.String(), Type.Null()]),
    latestRestoreDrillAt: NullableTimestamp,
  }),
  attention: Type.Array(Type.Object({
    code: Type.String(), severity: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('blocking')]),
    count: Type.Integer(), details: Type.Record(Type.String(), Type.Union([
      Type.String(), Type.Number(), Type.Boolean(), Type.Null(),
    ])),
  })),
})

const AdminAccount = Type.Object({
  id: Type.String({ format: 'uuid' }),
  login: Type.String(),
  isAdmin: Type.Boolean(),
  suspendedAt: NullableTimestamp,
  deletionRequestedAt: NullableTimestamp,
  createdAt: Timestamp,
  workspaceCount: Type.Integer(),
  objectCount: Type.Integer(),
  deviceCount: Type.Integer(),
})

const AdminAuditEntry = Type.Object({
  id: Type.String(),
  actorAccountId: Type.String({ format: 'uuid' }),
  actorLogin: Type.String(),
  action: Type.String(),
  targetType: Type.String(),
  targetId: Type.Union([Type.String(), Type.Null()]),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Timestamp,
})
const PaginationQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  query: Type.Optional(Type.String({ maxLength: 200 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
})
const AdminWorkspace = Type.Object({
  id: Type.String({ format: 'uuid' }), accountId: Type.String({ format: 'uuid' }), accountLogin: Type.String(),
  isDefault: Type.Boolean(), deletedAt: NullableTimestamp, createdAt: Timestamp, updatedAt: Timestamp,
  objectCount: Type.Integer(), deletedObjectCount: Type.Integer(), objectBytes: Type.String(),
  encryptionMode: Type.Union([Type.Literal('managed'), Type.Literal('e2ee')]),
})
const AdminDevice = Type.Object({
  id: Type.String({ format: 'uuid' }), accountId: Type.String({ format: 'uuid' }), accountLogin: Type.String(),
  name: Type.String(), platform: Type.String(), revokedAt: NullableTimestamp, lastSeenAt: Timestamp, createdAt: Timestamp,
})
const EmptyResponse = Type.Null()
const StorageReport = Type.Object({
  checked: Type.Integer(), missing: Type.Array(Type.String()), orphaned: Type.Array(Type.String()),
  deleted: Type.Optional(Type.Integer()),
})
const AdminJob = Type.Object({
  id: Type.String({ format: 'uuid' }), actorAccountId: Type.String({ format: 'uuid' }),
  type: Type.String(), status: Type.String(), progress: Type.Integer(),
  result: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]), startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp, createdAt: Timestamp,
})
const RiskRestriction = Type.Object({
  id: Type.String({ format: 'uuid' }),
  scope: Type.Union([Type.Literal('authentication'), Type.Literal('recovery'), Type.Literal('registration'), Type.Literal('device'), Type.Literal('sync_write'), Type.Literal('blob'), Type.Literal('billing'), Type.Literal('all')]),
  action: Type.Union([Type.Literal('challenge'), Type.Literal('deny'), Type.Literal('lock'), Type.Literal('read_only'), Type.Literal('review')]),
  reasonCode: Type.String(), source: Type.String(), expiresAt: NullableTimestamp,
  createdBy: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]), revokedAt: NullableTimestamp,
  revokedBy: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]), createdAt: Timestamp,
})
const RiskEvent = Type.Object({
  id: Type.String(), eventType: Type.String(), requestId: Type.String(), outcome: Type.String(),
  reasonCodes: Type.Array(Type.String()), createdAt: Timestamp,
})
const AccountRiskRestrictionBody = Type.Object({
  scope: Type.Union([Type.Literal('authentication'), Type.Literal('recovery'), Type.Literal('device'), Type.Literal('sync_write'), Type.Literal('blob'), Type.Literal('billing'), Type.Literal('all')]),
  action: Type.Union([Type.Literal('challenge'), Type.Literal('deny'), Type.Literal('lock'), Type.Literal('read_only'), Type.Literal('review')]),
  reasonCode: Type.String({ minLength: 3, maxLength: 100, pattern: '^[a-z0-9][a-z0-9_.-]*$' }),
  expiresAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
})
const AccountUsage = Type.Object({
  revision: Type.String(),
  metrics: Type.Record(Type.String(), Type.String()),
  updatedAt: NullableTimestamp,
})
const RuntimeConfiguration = Type.Object({
  serverName: Type.String({ minLength: 1, maxLength: 100 }),
  maxObjectBytes: Type.Integer({ minimum: 1, maximum: 67_108_864 }),
  maxBlobBytes: Type.Integer({ minimum: 1, maximum: 1_099_511_627_776 }),
  changeRetentionDays: Type.Integer({ minimum: 1, maximum: 3650 }),
  versionRetentionDays: Type.Integer({ minimum: 1, maximum: 3650 }),
  tombstoneRetentionDays: Type.Integer({ minimum: 1, maximum: 3650 }),
  mailDefaultLocale: Type.Union([Type.Literal('en'), Type.Literal('zh-CN')]),
  pendingEmailVerificationDays: Type.Integer({ minimum: 1, maximum: 90 }),
  accountDeletionCoolingOffDays: Type.Integer({ minimum: 1, maximum: 365 }),
  accountDeletionRetentionDays: Type.Integer({ minimum: 1, maximum: 3650 }),
  mailDriver: Type.Union([Type.Literal('disabled'), Type.Literal('smtp')]),
  mailFromAddress: Type.String({ maxLength: 320 }),
  mailFromName: Type.String({ maxLength: 200 }),
  mailReplyTo: Type.String({ maxLength: 320 }),
  smtpHost: Type.String({ maxLength: 255 }),
  smtpPort: Type.Integer({ minimum: 1, maximum: 65_535 }),
  smtpTlsMode: Type.Union([Type.Literal('starttls-required'), Type.Literal('starttls'), Type.Literal('tls'), Type.Literal('none')]),
  smtpUsername: Type.String({ maxLength: 500 }),
  smtpPasswordConfigured: Type.Boolean(),
  smtpConnectTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 120_000 }),
  smtpCommandTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 120_000 }),
  smtpTlsRejectUnauthorized: Type.Boolean(),
})

export function createWebAdminRoutes(
  _config: AppConfig,
  admin: AdminService,
  webSessions: WebSessionService,
  stepUps: WebStepUpService,
  capabilities: CapabilityRegistry | undefined,
  serverVersion: string,
): FastifyPluginAsyncTypebox {
  return async function webAdminRoutes(app) {
    app.get('/v1/web/admin/summary', {
      schema: { response: { 200: AdminSummaryResponse } },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.getSummary(session.accountId, serverVersion)
    })

    app.get('/v1/web/admin/capabilities', {
      schema: { response: { 200: Type.Object({
        deploymentMode: Type.Literal('self-hosted'),
        generatedAt: Timestamp,
        capabilities: Type.Array(Type.Object({
          id: Type.String(), lifecycle: Type.Union([Type.Literal('stable'), Type.Literal('experimental')]),
          status: Type.Union([Type.Literal('available'), Type.Literal('disabled'), Type.Literal('unavailable'), Type.Literal('degraded')]),
          requestedBy: Type.Union([Type.Literal('enabled_override'), Type.Literal('disabled_override'), Type.Literal('default'), Type.Literal('lifecycle')]),
          reasons: Type.Array(Type.String()),
          dependencies: Type.Array(Type.Object({ id: Type.String(), available: Type.Boolean() })),
        })),
      }) } },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      await admin.assertAdmin(session.accountId)
      const experimental = new Set([
        'identity.email', 'identity.emailVerification', 'identity.passwordReset',
        'operations.unifiedBackup', 'operations.upgradeAssistant', 'operations.preserveRestore',
      ])
      const rows = capabilityIds.map((id) => {
        const explanation = capabilities?.explain(id) ?? {
          id, available: false, deploymentMode: 'self-hosted' as const, requestedBy: 'default' as const,
          reasons: ['capability_registry_unavailable'], dependencies: [],
        }
        const status = explanation.available
          ? 'available' as const
          : explanation.reasons.includes('unsupported_deployment_mode') || explanation.reasons.includes('restore_safety_gated')
            ? 'unavailable' as const
            : 'disabled' as const
        return {
          id,
          lifecycle: experimental.has(id) ? 'experimental' as const : 'stable' as const,
          status,
          requestedBy: explanation.requestedBy,
          reasons: explanation.reasons,
          dependencies: explanation.dependencies,
        }
      })
      return {
        deploymentMode: 'self-hosted' as const,
        generatedAt: new Date(),
        capabilities: rows,
      }
    })

    app.get('/v1/web/admin/overview', {
      schema: { response: { 200: AdminOverviewResponse } },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.getOverview(session.accountId)
    })

    app.get('/v1/web/admin/accounts', {
      schema: {
        querystring: Type.Intersect([PaginationQuery, Type.Object({ status: Type.Optional(Type.Union([
          Type.Literal('all'), Type.Literal('active'), Type.Literal('suspended'), Type.Literal('deletion'),
        ])) })]),
        response: {
          200: Type.Object({
            total: Type.Integer(), nextCursor: Type.Union([Type.String(), Type.Null()]),
            accounts: Type.Array(AdminAccount),
          }),
        },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listAccounts(session.accountId, {
        limit: request.query.limit ?? 50, offset: request.query.offset ?? 0,
        query: request.query.query ?? '', status: request.query.status ?? 'all',
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      })
    })

    app.get('/v1/web/admin/workspaces', { schema: {
      querystring: PaginationQuery,
      response: { 200: Type.Object({ total: Type.Integer(), nextCursor: Type.Union([Type.String(), Type.Null()]), workspaces: Type.Array(AdminWorkspace) }) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listWorkspaces(session.accountId, {
        limit: request.query.limit ?? 50, offset: request.query.offset ?? 0, query: request.query.query ?? '',
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      })
    })

    app.get('/v1/web/admin/devices', { schema: {
      querystring: PaginationQuery,
      response: { 200: Type.Object({ total: Type.Integer(), nextCursor: Type.Union([Type.String(), Type.Null()]), devices: Type.Array(AdminDevice) }) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listDevices(session.accountId, {
        limit: request.query.limit ?? 50, offset: request.query.offset ?? 0, query: request.query.query ?? '',
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      })
    })

    app.get('/v1/web/admin/status', { schema: { response: { 200: AdminSystemStatusResponse } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.getSystemStatus(session.accountId)
    })

    app.get('/v1/web/admin/configuration', { schema: {
      response: { 200: Type.Record(Type.String(), Type.Unknown()) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.getRuntimeConfiguration(session.accountId)
    })

    app.put('/v1/web/admin/configuration', { schema: {
      headers: Type.Object({ 'x-step-up-token': Type.Optional(Type.String()) }),
      body: Type.Object({
        revision: Type.String({ pattern: '^[0-9]+$', maxLength: 18 }),
        configuration: RuntimeConfiguration,
        smtpPassword: Type.Optional(Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()])),
      }),
      response: { 200: Type.Record(Type.String(), Type.Unknown()) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await stepUps.consumeAccountGrant({
        token: request.headers['x-step-up-token'],
        accountId: session.accountId,
        sessionId: session.sessionId,
        audience: 'runtime.configuration.update',
        requestHash: stepUps.requestHash(request.body),
      })
      return admin.updateRuntimeConfiguration(session.accountId, request.body.configuration, request.body.revision, request.body.smtpPassword)
    })

    app.get('/v1/web/admin/sessions', { schema: {
      querystring: PaginationQuery,
      response: { 200: Type.Object({ total: Type.Integer(), sessions: Type.Array(Type.Object({
        id: Type.String({ format: 'uuid' }), accountId: Type.String({ format: 'uuid' }), accountLogin: Type.String(),
        expiresAt: Timestamp, lastSeenAt: Timestamp, lastIp: Type.Union([Type.String(), Type.Null()]),
        userAgent: Type.Union([Type.String(), Type.Null()]), createdAt: Timestamp,
      })) }) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listWebSessions(session.accountId, {
        limit: request.query.limit ?? 50, offset: request.query.offset ?? 0, query: request.query.query ?? '',
      })
    })

    app.delete('/v1/web/admin/sessions/:sessionId', { schema: {
      params: Type.Object({ sessionId: Type.String({ format: 'uuid' }) }),
      response: { 204: EmptyResponse },
    } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await admin.revokeWebSession(session.accountId, request.params.sessionId)
      return reply.status(204).send(null)
    })

    app.delete('/v1/web/admin/accounts/:accountId/sessions', { schema: {
      params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }),
      response: { 200: Type.Object({ revoked: Type.Integer() }) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return admin.revokeAccountWebSessions(session.accountId, request.params.accountId)
    })

    app.post('/v1/web/admin/workspaces/:workspaceId/restore', { schema: {
      params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }),
      response: { 204: EmptyResponse },
    } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await admin.restoreWorkspace(session.accountId, request.params.workspaceId)
      return reply.status(204).send(null)
    })

    app.get('/v1/web/admin/storage/orphans', { schema: { response: { 200: StorageReport } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.inspectStorage(session.accountId)
    })

    app.post('/v1/web/admin/storage/reconcile', { schema: {
      body: Type.Object({ deleteOrphaned: Type.Boolean() }),
      response: { 200: StorageReport },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return admin.reconcileStorage(session.accountId, request.body.deleteOrphaned)
    })

    app.post('/v1/web/admin/backups', { schema: { response: { 202: Type.Object({
      jobId: Type.String({ format: 'uuid' }), backupId: Type.String({ format: 'uuid' }),
    }) } } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return reply.status(202).send(await admin.createBackup(session.accountId))
    })

    app.get('/v1/web/admin/backups', { schema: { response: { 200: Type.Array(Type.Object({
      id: Type.String({ format: 'uuid' }), jobId: Type.String({ format: 'uuid' }), filename: Type.String(),
      size: Type.Union([Type.String(), Type.Null()]), status: Type.String(), createdAt: Timestamp,
      completedAt: NullableTimestamp,
    })) } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listBackups(session.accountId)
    })

    app.get('/v1/web/admin/backups/:backupId/download', { schema: {
      params: Type.Object({ backupId: Type.String({ format: 'uuid' }) }),
      response: { 200: Type.Any() },
    } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      const backup = await admin.getBackupFile(session.accountId, request.params.backupId)
      reply.header('content-disposition', `attachment; filename="${backup.filename}"`)
      return reply.type('application/octet-stream').send(createReadStream(backup.path))
    })

    app.delete('/v1/web/admin/backups/:backupId', { schema: {
      params: Type.Object({ backupId: Type.String({ format: 'uuid' }) }), response: { 204: EmptyResponse },
    } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await admin.deleteBackup(session.accountId, request.params.backupId)
      return reply.status(204).send(null)
    })

    app.get('/v1/web/admin/jobs', { schema: { response: { 200: Type.Array(AdminJob) } } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listJobs(session.accountId)
    })

    app.get('/v1/web/admin/jobs/:jobId', { schema: {
      params: Type.Object({ jobId: Type.String({ format: 'uuid' }) }),
      response: { 200: AdminJob },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.getJob(session.accountId, request.params.jobId)
    })

    app.delete('/v1/web/admin/workspaces/:workspaceId', { schema: {
      params: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }),
      response: { 204: EmptyResponse },
    } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await admin.deleteWorkspace(session.accountId, request.params.workspaceId)
      return reply.status(204).send(null)
    })

    app.delete('/v1/web/admin/devices/:deviceId', { schema: {
      params: Type.Object({ deviceId: Type.String({ format: 'uuid' }) }),
      response: { 204: EmptyResponse },
    } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await admin.revokeDevice(session.accountId, request.params.deviceId)
      return reply.status(204).send(null)
    })

    app.patch('/v1/web/admin/accounts/:accountId', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }),
        body: Type.Object({ suspended: Type.Boolean() }),
        response: { 204: EmptyResponse },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(
        request.headers['x-csrf-token'],
        request.cookies[WEB_CSRF_COOKIE],
        session,
        webSessions,
      )
      await admin.setAccountSuspended(session.accountId, request.params.accountId, request.body.suspended)
      return reply.status(204).send(null)
    })

    app.patch('/v1/web/admin/accounts/:accountId/role', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }),
        body: Type.Object({ isAdmin: Type.Boolean() }),
        response: { 204: EmptyResponse },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(
        request.headers['x-csrf-token'],
        request.cookies[WEB_CSRF_COOKIE],
        session,
        webSessions,
      )
      await admin.setAccountAdmin(session.accountId, request.params.accountId, request.body.isAdmin)
      return reply.status(204).send(null)
    })

    app.post('/v1/web/admin/accounts/batch', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({
          accountIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 50 }),
          suspended: Type.Boolean(),
        }),
        response: { 200: Type.Object({ updated: Type.Integer() }) },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return admin.batchSetAccountsSuspended(session.accountId, request.body.accountIds, request.body.suspended)
    })

    app.get('/v1/web/admin/accounts/:accountId/risk/restrictions', { schema: {
      params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }),
      response: { 200: Type.Array(RiskRestriction) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listAccountRiskRestrictions(session.accountId, request.params.accountId)
    })

    app.get('/v1/web/admin/accounts/:accountId/risk/events', { schema: {
      params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }),
      response: { 200: Type.Array(RiskEvent) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listAccountRiskEvents(session.accountId, request.params.accountId)
    })

    app.get('/v1/web/admin/accounts/:accountId/usage', { schema: {
      params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }), response: { 200: AccountUsage },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.getAccountUsage(session.accountId, request.params.accountId)
    })

    app.post('/v1/web/admin/accounts/:accountId/usage/reconcile', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }), response: { 200: AccountUsage } },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return admin.reconcileAccountUsage(session.accountId, request.params.accountId)
    })

    app.put('/v1/web/admin/accounts/:accountId/risk/restrictions', {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        params: Type.Object({ accountId: Type.String({ format: 'uuid' }) }), body: AccountRiskRestrictionBody,
        response: { 200: Type.Object({ id: Type.String({ format: 'uuid' }) }) },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      const expiresAt = request.body.expiresAt === undefined || request.body.expiresAt === null ? null : new Date(request.body.expiresAt)
      return admin.upsertAccountRiskRestriction(session.accountId, { ...request.body, targetAccountId: request.params.accountId, expiresAt })
    })

    app.delete('/v1/web/admin/risk/restrictions/:restrictionId', { schema: {
      params: Type.Object({ restrictionId: Type.String({ format: 'uuid' }) }), response: { 204: EmptyResponse },
    } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await admin.revokeAccountRiskRestriction(session.accountId, request.params.restrictionId)
      return reply.status(204).send(null)
    })

    app.get('/v1/web/admin/audit', {
      schema: {
        querystring: Type.Intersect([PaginationQuery, Type.Object({ action: Type.Optional(Type.String({ maxLength: 100 })) })]),
        response: { 200: Type.Object({ total: Type.Integer(), nextCursor: Type.Union([Type.String(), Type.Null()]), entries: Type.Array(AdminAuditEntry) }) },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return admin.listAudit(session.accountId, {
        limit: request.query.limit ?? 50, offset: request.query.offset ?? 0,
        query: request.query.query ?? '', action: request.query.action ?? '',
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      })
    })

    app.delete('/v1/web/admin/audit', { schema: {
      querystring: Type.Object({ retentionDays: Type.Integer({ minimum: 1, maximum: 3650 }) }),
      response: { 200: Type.Object({ deleted: Type.Integer() }) },
    } }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      return admin.deleteOldAudit(session.accountId, request.query.retentionDays)
    })

    app.get('/v1/web/admin/export', { schema: { querystring: Type.Object({
      scope: Type.Union([Type.Literal('accounts'), Type.Literal('workspaces'), Type.Literal('devices'), Type.Literal('audit')]),
    }), response: { 200: Type.Record(Type.String(), Type.Unknown()) } } }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      await admin.recordAudit(session.accountId, 'data.export', request.query.scope, null)
      await streamAdminExport(reply, admin, session.accountId, request.query.scope)
    })
  }
}

async function streamAdminExport(
  reply: FastifyReply,
  admin: AdminService,
  accountId: string,
  scope: 'accounts' | 'workspaces' | 'devices' | 'audit',
): Promise<void> {
  const pageSize = 1_000
  let cursor: string | undefined
  const key = scope === 'accounts' ? 'accounts' : scope === 'workspaces' ? 'workspaces' : scope === 'devices' ? 'devices' : 'entries'
  const generatedAt = new Date().toISOString()
  reply.hijack()
  reply.raw.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="notegen-${scope}-${generatedAt.slice(0, 10)}.json"`,
  })
  let first = true
  let total = 0
  await writeChunk(reply.raw, `{"generatedAt":${JSON.stringify(generatedAt)},"scope":${JSON.stringify(scope)},"data":{"total":`)
  do {
    const cursorOption = cursor === undefined ? {} : { cursor }
    const page = (scope === 'accounts'
      ? await admin.listAccounts(accountId, { limit: pageSize, offset: 0, query: '', status: 'all', ...cursorOption })
      : scope === 'workspaces'
        ? await admin.listWorkspaces(accountId, { limit: pageSize, offset: 0, query: '', ...cursorOption })
        : scope === 'devices'
          ? await admin.listDevices(accountId, { limit: pageSize, offset: 0, query: '', ...cursorOption })
          : await admin.listAudit(accountId, { limit: pageSize, offset: 0, query: '', action: '', ...cursorOption })) as {
            total: number
            nextCursor: string | null
            [key: string]: unknown
          }
    total = page.total
    const items = page[key as keyof typeof page]
    if (!Array.isArray(items)) break
    if (first) {
      await writeChunk(reply.raw, `${total},${JSON.stringify(key)}:[`)
      first = false
    }
    for (const item of items) {
      await writeChunk(reply.raw, `${cursor === undefined && item === items[0] ? '' : ','}${JSON.stringify(item)}`)
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  if (first) await writeChunk(reply.raw, `${total},${JSON.stringify(key)}:[`)
  reply.raw.end(']}}')
}

async function writeChunk(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain')
}
