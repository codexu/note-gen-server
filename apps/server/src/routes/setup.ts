import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import type { BootstrapService } from '../bootstrap/service.js'
import type { DeploymentService } from '../deployment/service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import { assertTrustedOrigin, sessionContext, setSessionCookies } from './web-auth.js'
import { ApiError } from '../errors.js'

export function createSetupRoutes(
  config: AppConfig,
  bootstrap: BootstrapService,
  deployment: DeploymentService,
  webSessions: WebSessionService,
): FastifyPluginAsyncTypebox {
  return async function setupRoutes(app) {
    app.get('/v1/setup/status', { schema: { response: { 200: Type.Object({
      setupRequired: Type.Boolean(), serverName: Type.String(), checks: Type.Array(Type.Object({ code: Type.String(), severity: Type.Union([Type.Literal('blocking'), Type.Literal('warning')]) })),
    }) } } }, async () => {
      return setupStatus(config, deployment)
    })

    app.post('/v1/setup/validate', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { response: { 200: Type.Object({
        setupRequired: Type.Literal(true), serverName: Type.String(), checks: Type.Array(Type.Object({ code: Type.String(), severity: Type.Union([Type.Literal('blocking'), Type.Literal('warning')]) })),
      }) } },
    }, async (request) => {
      assertTrustedOrigin(config, request.headers.origin)
      if (!deployment.canBootstrapAdministrator()) {
        throw new ApiError({ code: 'setup_not_required', message: 'Setup is not available', statusCode: 404 })
      }
      return { ...setupStatus(config, deployment), setupRequired: true as const }
    })

    app.post('/v1/setup/complete', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        headers: Type.Object({ 'x-setup-token': Type.Optional(Type.String()) }),
        body: Type.Object({ login: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }), password: Type.String({ minLength: 8, maxLength: 1024 }), token: Type.Optional(Type.String()) }),
        response: {
          201: Type.Object({ account: Type.Object({ id: Type.String({ format: 'uuid' }), login: Type.String(), isAdmin: Type.Literal(true), totpEnabled: Type.Literal(false) }) }),
          202: Type.Object({ account: Type.Object({ id: Type.String({ format: 'uuid' }), login: Type.String(), isAdmin: Type.Literal(true), totpEnabled: Type.Literal(false) }), code: Type.Literal('setup_completed_login_required') }),
        },
      },
    }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      if (!deployment.canBootstrapAdministrator()) {
        throw new ApiError({ code: 'setup_not_required', message: 'Setup is not available', statusCode: 404 })
      }
      const token = request.headers['x-setup-token'] ?? request.body.token
      if (token === undefined) throw new ApiError({ code: 'setup_token_invalid', message: 'Setup token is required', statusCode: 403 })
      const account = await bootstrap.complete(request.body.login, request.body.password, token)
      try {
        const session = await webSessions.create(account.id, sessionContext(request))
        setSessionCookies(config, reply, session)
      } catch {
        return reply.status(202).send({ account, code: 'setup_completed_login_required' })
      }
      return reply.status(201).send({ account })
    })
  }
}

function setupStatus(config: AppConfig, deployment: DeploymentService): {
  setupRequired: boolean
  serverName: string
  checks: Array<{ code: string, severity: 'blocking' | 'warning' }>
} {
  const checks: Array<{ code: string, severity: 'blocking' | 'warning' }> = []
  if (config.nodeEnv === 'production' && config.publicBaseUrl.startsWith('http:')) {
    checks.push({ code: 'public_url_not_https', severity: 'warning' })
  }
  if (deployment.getState().adminRepairRequired) {
    checks.push({ code: 'administrator_repair_required', severity: 'warning' })
  }
  return { setupRequired: deployment.canBootstrapAdministrator(), serverName: config.serverName, checks }
}
