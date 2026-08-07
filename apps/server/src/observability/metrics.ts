import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client'
import type { AppConfig } from '../config.js'

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
