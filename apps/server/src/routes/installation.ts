import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import type { InstallationService } from '../installation/service.js'
import { assertTrustedOrigin } from './web-auth.js'

export function createInstallationRoutes(
  config: AppConfig,
  installation: InstallationService,
  onInstallationComplete?: () => void,
): FastifyPluginAsyncTypebox {
  return async function installationRoutes(app) {
    const Status = Type.Object({
      installationRequired: Type.Boolean(),
      activationPending: Type.Boolean(),
      serverName: Type.String(),
    })

    app.get('/v1/installation/status', { schema: { response: { 200: Status } } }, async () => installation.status())

    app.post('/v1/installation/complete', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({
          serverName: Type.String({ minLength: 1, maxLength: 100, pattern: '.*\\S.*' }),
          administrator: Type.Object({
            login: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
            password: Type.String({ minLength: 8, maxLength: 1024 }),
          }),
        }),
        response: {
          201: Type.Object({
            serverName: Type.String(),
            activationPending: Type.Literal(true),
          }),
        },
      },
    }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const result = await installation.complete(request.body)
      if (onInstallationComplete !== undefined) {
        reply.raw.once('finish', onInstallationComplete)
      }
      return reply.status(201).send(result)
    })
  }
}
