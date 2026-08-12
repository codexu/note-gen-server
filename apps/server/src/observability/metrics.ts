import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client'
import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'

export function registerMetrics(app: FastifyInstance, config: AppConfig): void {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry, prefix: 'notegen_sync_' })
  const requestDuration = new Histogram({
    name: 'notegen_sync_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  })
  const requestFailures = new Counter({
    name: 'notegen_sync_api_errors_total',
    help: 'Structured API errors by route and stable code',
    labelNames: ['route', 'code'] as const,
    registers: [registry],
  })
  const syncBatchSize = new Histogram({
    name: 'notegen_sync_command_batch_size',
    help: 'Number of commands submitted in a durable sync batch',
    registers: [registry],
    buckets: [1, 2, 5, 10, 25, 50, 100],
  })
  const blobRequestBytes = new Histogram({
    name: 'notegen_sync_blob_request_bytes',
    help: 'Declared body size for Blob upload requests',
    registers: [registry],
    buckets: [1_024, 64 * 1_024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024],
  })

  app.addHook('onRequest', async (request) => {
    request.metricsStartedAt = process.hrtime.bigint()
  })
  app.addHook('onResponse', async (request, reply) => {
    const startedAt = request.metricsStartedAt
    if (startedAt === undefined) return
    requestDuration.observe({
      method: request.method,
      route: request.routeOptions.url ?? 'unknown',
      status_code: String(reply.statusCode),
    }, Number(process.hrtime.bigint() - startedAt) / 1_000_000_000)
    const route = request.routeOptions.url ?? ''
    if (route.endsWith('/sync/commands') && request.method === 'POST') {
      const body = request.body as { commands?: unknown[] } | undefined
      if (Array.isArray(body?.commands)) syncBatchSize.observe(body.commands.length)
    }
    if (route.includes('/blobs/uploads') && request.method === 'PUT') {
      const contentLength = Number(request.headers['content-length'])
      if (Number.isFinite(contentLength) && contentLength >= 0) blobRequestBytes.observe(contentLength)
    }
  })
  app.addHook('onError', async (request, _reply, error) => {
    requestFailures.inc({
      route: request.routeOptions.url ?? 'unknown',
      code: error instanceof ApiError ? error.code : error.validation === undefined ? 'internal_error' : 'request_invalid',
    })
  })
  app.get('/metrics', { schema: { hide: true } }, async (request, reply) => {
    if (!config.metricsEnabled) return reply.status(404).send()
    if (config.metricsToken.length > 0) {
      const authorization = request.headers.authorization
      const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
      const left = Buffer.from(supplied)
      const right = Buffer.from(config.metricsToken)
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        return reply.status(401).send()
      }
    }
    return reply.type(registry.contentType).send(await registry.metrics())
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    metricsStartedAt?: bigint
  }
}
