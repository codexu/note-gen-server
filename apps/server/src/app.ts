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
import { registerErrorHandler } from './errors.js'
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
import { createDeviceAuthorizationRoutes } from './routes/device-authorizations.js'
import { createDevicePairingRoutes } from './routes/device-pairings.js'
import { createWebAdminRoutes } from './routes/web-admin.js'
import { createCollaborationRoutes } from './routes/collab.js'
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
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.refreshToken',
          'req.body.setupToken',
          'req.body.deviceCode',
          'req.body.pairingToken',
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
      'authorization', 'content-type', 'x-request-id', 'x-setup-token', 'x-csrf-token', 'range',
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
      428: ErrorResponse,
      429: ErrorResponse,
      500: ErrorResponse,
      503: ErrorResponse,
      ...existingResponses,
    }
  })
  await app.register(createHealthRoutes(dependencies))
  await app.register(createCapabilitiesRoutes(config, dependencies))
  if (dependencies.auth !== undefined && dependencies.tokens !== undefined) {
    await app.register(createAuthRoutes(config, dependencies.auth, dependencies.tokens))
  }
  if (dependencies.workspaces !== undefined && dependencies.tokens !== undefined && dependencies.auth !== undefined) {
    await app.register(createWorkspaceRoutes(dependencies.workspaces, dependencies.tokens, dependencies.auth))
  }
  if (dependencies.sync !== undefined && dependencies.tokens !== undefined && dependencies.auth !== undefined) {
    await app.register(createSyncRoutes(dependencies.sync, dependencies.tokens, dependencies.auth))
  }
  if (dependencies.tokens !== undefined && dependencies.workspaces !== undefined
    && dependencies.notifier !== undefined && dependencies.auth !== undefined) {
    await app.register(createEventRoutes(
      dependencies.tokens, dependencies.auth, dependencies.workspaces, dependencies.notifier,
    ))
  }
  if (dependencies.collaboration !== undefined && dependencies.tokens !== undefined
    && dependencies.auth !== undefined && dependencies.workspaces !== undefined) {
    await app.register(createCollaborationRoutes(
      dependencies.collaboration, dependencies.tokens, dependencies.auth, dependencies.workspaces,
    ))
  }
  if (dependencies.blobs !== undefined && dependencies.tokens !== undefined && dependencies.auth !== undefined) {
    await app.register(createBlobRoutes(
      dependencies.blobs, dependencies.tokens, dependencies.auth, config.blobPartBytes,
    ))
  }
  if (dependencies.auth !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createWebAuthRoutes(
      config, dependencies.auth, dependencies.webSessions, dependencies.admin,
    ))
  }
  if (dependencies.workspaces !== undefined && dependencies.sync !== undefined
    && dependencies.webSessions !== undefined) {
    await app.register(createWebDashboardRoutes(
      dependencies.workspaces, dependencies.sync, dependencies.webSessions, dependencies.admin,
    ))
  }
  if (dependencies.admin !== undefined && dependencies.webSessions !== undefined) {
    await app.register(createWebAdminRoutes(config, dependencies.admin, dependencies.webSessions))
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
