import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { ServiceDependencies } from '../services.js'

const HealthResponse = Type.Object({ status: Type.Literal('ok'), version: Type.String() })
const NotReadyResponse = Type.Object({ status: Type.Literal('not_ready'), requestId: Type.String() })

export function createHealthRoutes(dependencies: ServiceDependencies): FastifyPluginAsyncTypebox {
  return async function healthRoutes(app) {
    app.get('/health/live', {
      schema: { response: { 200: HealthResponse } },
    }, async () => ({ status: 'ok' as const, version: dependencies.version }))

    app.get('/health/ready', {
      schema: { response: { 200: HealthResponse, 503: NotReadyResponse } },
    }, async (request, reply) => {
      try {
        await Promise.all([dependencies.database.check(), dependencies.blobStorage.check()])
        return { status: 'ok' as const, version: dependencies.version }
      } catch (error) {
        request.log.warn({ err: error }, 'Readiness check failed')
        return reply.status(503).send({ status: 'not_ready' as const, requestId: request.id })
      }
    })
  }
}
