import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import cookie from '@fastify/cookie'
import swagger from '@fastify/swagger'
import fastifyStatic from '@fastify/static'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from './config.js'
import { ApiError, registerErrorHandler } from './errors.js'
import { requireAuth } from './auth/http-auth.js'
import { createAccountContextRoutes } from './routes/account-context.js'
import { createSetupRoutes } from './routes/setup.js'
import { createInvitationRoutes } from './routes/invitations.js'
import { createComplianceRoutes } from './routes/compliance.js'
import { createBillingRoutes } from './routes/billing.js'
import { createCapabilitiesRoutes } from './routes/capabilities.js'
import { createHealthRoutes } from './routes/health.js'
import { createAuthRoutes } from './routes/auth.js'
import { createWorkspaceRoutes } from './routes/workspaces.js'
import { createWebDashboardRoutes } from './routes/web-dashboard.js'
import { createSyncRoutes } from './routes/sync.js'
import { createEventRoutes } from './routes/events.js'
import { createBlobRoutes } from './routes/blobs.js'
import type { ServiceDependencies } from './services.js'
import { registerMetrics } from './observability/metrics.js'
import { createWebAuthRoutes } from './routes/web-auth.js'
import { createWebEmailRoutes } from './routes/web-email.js'
import { createDeviceAuthorizationRoutes } from './routes/device-authorizations.js'
import { createDevicePairingRoutes } from './routes/device-pairings.js'
import { createWebAdminRoutes } from './routes/web-admin.js'
import { createSupportRoutes } from './routes/support.js'
import { createMailAdminRoutes } from './routes/mail-admin.js'
import { createStaffSupportRoutes } from './routes/staff-support.js'
import { createStaffLegalHoldRoutes } from './routes/staff-legal-holds.js'
import { createStaffBillingRoutes } from './routes/staff-billing.js'
import { createStaffRiskRoutes } from './routes/staff-risk.js'
import { isAllowedDevelopmentWebOrigin } from './development-origin.js'
import { createPostgresRateLimitStore } from './observability/postgres-rate-limit-store.js'
import type { DatabaseContext } from './database/client.js'

export async function buildApp(
  config: AppConfig,
  dependencies: ServiceDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-setup-token"]',
          'req.headers["x-step-up-token"]',
          'req.headers["x-staff-session-id"]',
          'req.body.password',
          'req.body.smtpPassword',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.refreshToken',
          'req.body.setupToken',
          'req.body.token',
          'req.body.cancelToken',
          'req.body.deviceCode',
          'req.body.pairingToken',
          'req.body.recipient',
          'req.body.ciphertext',
          'req.body.wrappedKey',
          'req.body.managedKey',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
        ],
        censor: '[REDACTED]',
      },
    },
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
    bodyLimit: config.maxRequestBytes,
  }).withTypeProvider<TypeBoxTypeProvider>()
  app.addContentTypeParser('application/octet-stream', {
    parseAs: 'buffer',
    bodyLimit: config.blobPartBytes,
  }, (_request, body, done) => done(null, body))

  await app.register(swagger, {
    openapi: {
      info: { title: 'NoteGen Sync Server API', version: dependencies.version },
    },
  })
  await app.register(cors, {
    origin: (origin, callback) => {
      const allowed = origin === undefined
        || config.corsOrigins.includes(origin)
        || isAllowedDevelopmentWebOrigin(config, origin)
      callback(null, allowed)
    },
    credentials: config.corsOrigins.length > 0 || config.nodeEnv === 'development',
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization', 'content-type', 'x-request-id', 'x-setup-token', 'x-step-up-token', 'x-staff-session-id', 'x-csrf-token', 'range',
    ],
    exposedHeaders: [
      'accept-ranges', 'content-length', 'content-range', 'retry-after',
      'x-ciphertext-hash', 'x-request-id',
    ],
  })
  await app.register(cookie)
  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    ...('sql' in dependencies.database
      ? { store: createPostgresRateLimitStore(dependencies.database as DatabaseContext) }
      : {}),
    skipOnError: false,
    errorResponseBuilder: (request, context) => ({
      code: 'rate_limited',
      message: `Rate limit exceeded, retry in ${context.after}`,
      requestId: request.id,
      retryable: true,
      details: { retryAfterMilliseconds: context.ttl },
    }),
  })
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } })
  registerMetrics(app, config)
  registerErrorHandler(app)
  app.addHook('onRequest', async (request) => {
    const safetyFailure = dependencies.deployment?.getSafetyFailure()
    if (safetyFailure !== undefined && request.url.split('?')[0] !== '/health/live' && request.url.split('?')[0] !== '/health/ready') {
      throw new ApiError({
        code: 'startup_safety_gate_closed', message: 'Instance startup safety gate is closed', statusCode: 503,
        retryable: false, details: { reason: safetyFailure },
      })
    }
    if (dependencies.maintenanceCoordinator !== undefined) {
      await dependencies.maintenanceCoordinator.requireServingAllowed(request.url.split('?')[0])
    }
  })
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0]
    if (dependencies.maintenanceCoordinator !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      await dependencies.maintenanceCoordinator.requireMutationAllowed(path)
    }
  })
  app.addHook('preHandler', async (request) => {
    if (dependencies.tokens === undefined || dependencies.auth === undefined) return
    const path = request.url.split('?')[0]
    // All Workspace mutations create or alter sync-domain state, including
    // key envelopes and recovery material. Do not limit the policy/risk gate
    // to the newest durable-command route: an older client could otherwise
    // write through another Workspace endpoint while sync.push is denied.
    const isWorkspaceWrite = path.startsWith('/v1/workspaces')
    const isDomainMutation = ['POST', 'PUT', 'PATCH'].includes(request.method)
    const isPolicyGatedWrite = isDomainMutation
      && (isWorkspaceWrite || path.includes('/sync/commands') || path.includes('/blobs/uploads'))
    if (!isPolicyGatedWrite) return
    const claims = await requireAuth(request, dependencies.tokens, dependencies.auth)
    if (dependencies.compliance !== undefined) {
      const missingPolicies = await dependencies.compliance.requiredReacceptance(claims.accountId)
      if (missingPolicies.length > 0) {
        throw new ApiError({ code: 'policy_reacceptance_required', message: 'Accept the current policies before creating or modifying synced data', statusCode: 423, details: { policyDocumentIds: missingPolicies } })
      }
    }
    if (dependencies.risk !== undefined) await dependencies.risk.enforceAccount(claims.accountId, path.includes('/blobs/uploads') ? 'blob' : 'sync_write')
  })
  const ErrorResponse = Type.Object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    retryable: Type.Boolean(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  })
  app.addHook('onRoute', (route) => {
    if (route.schema?.hide === true || route.websocket === true) return
    route.schema ??= {}
    const existingResponses = typeof route.schema.response === 'object' && route.schema.response !== null
      ? route.schema.response
      : {}
    route.schema.response = {
      400: ErrorResponse,
      401: ErrorResponse,
      403: ErrorResponse,
      404: ErrorResponse,
      409: ErrorResponse,
      413: ErrorResponse,
      415: ErrorResponse,
      416: ErrorResponse,
      422: ErrorResponse,
      423: ErrorResponse,
      428: ErrorResponse,
      429: ErrorResponse,
      500: ErrorResponse,
      503: ErrorResponse,
      ...existingResponses,
    }
  })
  await app.register(createHealthRoutes(dependencies))
  await app.register(createCapabilitiesRoutes(config, dependencies))
  if (config.deploymentMode === 'self-hosted'
    && dependencies.bootstrap !== undefined && dependencies.deployment !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createSetupRoutes(config, dependencies.bootstrap, dependencies.deployment, dependencies.webSessions))
  }
  if (dependencies.invitations !== undefined && dependencies.webSessions !== undefined && dependencies.stepUps !== undefined && dependencies.auth !== undefined) {
    await app.register(createInvitationRoutes(config, dependencies.invitations, dependencies.webSessions, dependencies.stepUps, dependencies.auth))
  }
  if (dependencies.compliance !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createComplianceRoutes(config, dependencies.compliance, dependencies.webSessions, dependencies.deletion, dependencies.stepUps))
  }
  if (dependencies.support !== undefined && dependencies.webSessions !== undefined
    && dependencies.capabilities?.resolvePublic()['support.cases'] === true) {
    await app.register(createSupportRoutes(dependencies.support, dependencies.webSessions))
  }
  if (config.deploymentMode === 'hosted' && config.hostedReleaseStage === 'internal-test'
    && dependencies.support !== undefined && dependencies.staffSessions !== undefined) {
    await app.register(createStaffSupportRoutes(dependencies.support, dependencies.staffSessions))
  }
  if (config.deploymentMode === 'hosted' && config.hostedReleaseStage === 'internal-test'
    && dependencies.legalHolds !== undefined && dependencies.staffSessions !== undefined) {
    await app.register(createStaffLegalHoldRoutes(dependencies.legalHolds, dependencies.staffSessions))
  }
  if (config.deploymentMode === 'hosted' && config.hostedReleaseStage === 'internal-test'
    && dependencies.entitlements !== undefined && dependencies.staffSessions !== undefined) {
    await app.register(createStaffBillingRoutes(dependencies.entitlements, dependencies.staffSessions))
  }
  if (config.deploymentMode === 'hosted' && config.hostedReleaseStage === 'internal-test' && dependencies.risk !== undefined && dependencies.staffSessions !== undefined) {
    await app.register(createStaffRiskRoutes(dependencies.risk, dependencies.staffSessions))
  }
  if (dependencies.entitlements !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createBillingRoutes(dependencies.entitlements, dependencies.webSessions))
  }
  if (dependencies.auth !== undefined && dependencies.tokens !== undefined) {
    if (dependencies.deployment === undefined) throw new Error('Auth routes require DeploymentService')
    await app.register(createAuthRoutes(config, dependencies.auth, dependencies.tokens, dependencies.deployment, dependencies.deletion, dependencies.risk))
  }
  if (dependencies.workspaces !== undefined && dependencies.tokens !== undefined && dependencies.auth !== undefined) {
    await app.register(createWorkspaceRoutes(config, dependencies.workspaces, dependencies.tokens, dependencies.auth))
  }
  if (dependencies.auth !== undefined && dependencies.tokens !== undefined && dependencies.deployment !== undefined) {
    await app.register(createAccountContextRoutes(dependencies.auth, dependencies.tokens, dependencies.deployment, dependencies.entitlements, dependencies.usage, dependencies.compliance, dependencies.risk, dependencies.usageHardEnforcementActive, dependencies.maintenanceCoordinator))
  }
  if (dependencies.syncProtocol !== undefined && dependencies.tokens !== undefined && dependencies.auth !== undefined) {
    await app.register(createSyncRoutes(dependencies.syncProtocol, dependencies.tokens, dependencies.auth))
  }
  if (dependencies.tokens !== undefined && dependencies.workspaces !== undefined
    && dependencies.notifier !== undefined && dependencies.auth !== undefined) {
    await app.register(createEventRoutes(
      dependencies.tokens, dependencies.auth, dependencies.workspaces, dependencies.notifier, dependencies.maintenanceCoordinator,
      dependencies.syncEpoch,
    ))
  }
  if (dependencies.blobs !== undefined && dependencies.tokens !== undefined && dependencies.auth !== undefined) {
    await app.register(createBlobRoutes(
      dependencies.blobs, dependencies.tokens, dependencies.auth, config.blobPartBytes, dependencies.risk,
    ))
  }
  if (dependencies.auth !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createWebAuthRoutes(
      config, dependencies.auth, dependencies.webSessions, dependencies.admin, dependencies.deployment, dependencies.risk,
    ))
  }
  if (dependencies.emailIdentities !== undefined && dependencies.deployment !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createWebEmailRoutes(config, dependencies.deployment, dependencies.emailIdentities, dependencies.webSessions))
  }
  if (dependencies.workspaces !== undefined && dependencies.sync !== undefined
    && dependencies.webSessions !== undefined) {
    await app.register(createWebDashboardRoutes(
      dependencies.workspaces, dependencies.sync, dependencies.webSessions, dependencies.admin,
    ))
  }
  if (dependencies.admin !== undefined && dependencies.webSessions !== undefined && dependencies.stepUps !== undefined) {
    await app.register(createWebAdminRoutes(config, dependencies.admin, dependencies.webSessions, dependencies.stepUps))
  }
  if (dependencies.mailAdmin !== undefined && dependencies.webSessions !== undefined && dependencies.stepUps !== undefined) {
    await app.register(createMailAdminRoutes(config, dependencies.mailAdmin, dependencies.webSessions, dependencies.stepUps))
  }
  if (dependencies.deviceAuthorizations !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createDeviceAuthorizationRoutes(
      config, dependencies.deviceAuthorizations, dependencies.webSessions,
    ))
  }
  if (dependencies.devicePairings !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createDevicePairingRoutes(
      config, dependencies.devicePairings, dependencies.webSessions, dependencies.instanceId,
    ))
  }
  if (config.openApiEnabled) {
    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())
  }

  const webRoot = resolve(config.webDistPath)
  if (config.webEnabled && existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      redirect: true,
    })
  }

  return app
}
