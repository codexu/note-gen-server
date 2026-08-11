import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import type { DeploymentService } from '../deployment/service.js'
import type { EmailIdentityService } from '../identity/email-service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import { ApiError } from '../errors.js'
import { assertTrustedOrigin, sessionContext, setSessionCookies } from './web-auth.js'

export function createWebEmailRoutes(
  config: AppConfig,
  deployment: DeploymentService,
  email: EmailIdentityService,
  webSessions: WebSessionService,
): FastifyPluginAsyncTypebox {
  return async function webEmailRoutes(app) {
    app.post('/v1/web/auth/register/email', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({ email: Type.String({ minLength: 3, maxLength: 320 }), password: Type.String({ minLength: 8, maxLength: 1_024 }) }),
        response: { 202: Type.Object({ status: Type.Literal('verification_pending') }) },
      },
    }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      if (!deployment.canRegisterNormally()) throw new ApiError({ code: 'registration_closed', message: 'Registration is closed', statusCode: 403 })
      try {
        await email.register(request.body.email, request.body.password)
      } catch (error) {
        // Email identity ownership is not public account-discovery data.
        if (!(error instanceof ApiError) || error.code !== 'identity_conflict') throw error
      }
      return reply.status(202).send({ status: 'verification_pending' as const })
    })

    app.post('/v1/web/auth/email/verify', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({ token: Type.String({ minLength: 20, maxLength: 512 }) }),
        response: { 200: Type.Object({ status: Type.Literal('verified') }) },
      },
    }, async (request) => {
      assertTrustedOrigin(config, request.headers.origin)
      await email.verify(request.body.token)
      return { status: 'verified' as const }
    })

    app.post('/v1/web/auth/email/resend', {
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
      schema: {
        body: Type.Object({ email: Type.String({ minLength: 3, maxLength: 320 }) }),
        response: { 202: Type.Object({ status: Type.Literal('accepted') }) },
      },
    }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      await email.resend(request.body.email)
      return reply.status(202).send({ status: 'accepted' as const })
    })

    app.post('/v1/web/auth/password-reset/request', {
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
      schema: {
        body: Type.Object({ email: Type.String({ minLength: 3, maxLength: 320 }) }),
        response: { 202: Type.Object({ status: Type.Literal('accepted') }) },
      },
    }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      await email.requestPasswordReset(request.body.email)
      return reply.status(202).send({ status: 'accepted' as const })
    })

    app.post('/v1/web/auth/password-reset/complete', {
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: {
        body: Type.Object({ token: Type.String({ minLength: 20, maxLength: 512 }), newPassword: Type.String({ minLength: 8, maxLength: 1_024 }) }),
        response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      assertTrustedOrigin(config, request.headers.origin)
      const reset = await email.resetPassword(request.body.token, request.body.newPassword)
      setSessionCookies(config, reply, await webSessions.create(reset.accountId, sessionContext(request), reset.credentialEpoch))
      return reply.status(204).send(null)
    })
  }
}
