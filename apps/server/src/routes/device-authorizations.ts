import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import type { DeviceAuthorizationService } from '../auth/device-authorization-service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import { resolveWebPublicBaseUrl } from '../development-origin.js'
import { requireCsrf, requireWebSession, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE } from './web-auth.js'
import { SessionResponse, Timestamp } from './api-schemas.js'

const DeviceInput = Type.Object({
  deviceId: Type.String({ format: 'uuid' }),
  deviceName: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
  platform: Type.String({ minLength: 1, maxLength: 50, pattern: '^[A-Za-z0-9._-]+$' }),
  encryptionPublicKey: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })),
})

export function createDeviceAuthorizationRoutes(
  config: AppConfig,
  authorizations: DeviceAuthorizationService,
  webSessions: WebSessionService,
): FastifyPluginAsyncTypebox {
  return async function deviceAuthorizationRoutes(app) {
    app.post('/v1/device-authorizations', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: DeviceInput, response: { 201: Type.Object({
        deviceCode: Type.String(), userCode: Type.String(), expiresIn: Type.Integer(), interval: Type.Integer(),
        verificationUri: Type.String({ format: 'uri' }), verificationUriComplete: Type.String({ format: 'uri' }),
      }) } },
    }, async (request, reply) => {
      const authorization = await authorizations.create(request.body)
      const verificationUri = `${resolveWebPublicBaseUrl(config, request)}/connect/`
      return reply.status(201).send({
        ...authorization,
        verificationUri,
        verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(authorization.userCode)}`,
      })
    })

    app.post('/v1/device-authorizations/token', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: Type.Object({ deviceCode: Type.String({ minLength: 20 }) }), response: { 200: SessionResponse } },
    }, async (request) => authorizations.exchange(request.body.deviceCode))

    app.post('/v1/device-authorizations/cancel', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: Type.Object({ deviceCode: Type.String({ minLength: 20 }) }), response: { 204: Type.Null() } },
    }, async (request, reply) => {
      await authorizations.cancel(request.body.deviceCode)
      return reply.status(204).send(null)
    })

    app.get('/v1/web/device-authorizations/:userCode', {
      schema: {
        params: Type.Object({ userCode: Type.String({ minLength: 8, maxLength: 20 }) }),
        response: { 200: Type.Object({
          userCode: Type.String(), deviceId: Type.String({ format: 'uuid' }), deviceName: Type.String(),
          platform: Type.String(), status: Type.Union([
            Type.Literal('pending'), Type.Literal('approved'), Type.Literal('denied'),
          ]), expiresAt: Timestamp,
        }) },
      },
    }, async (request) => {
      await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      return authorizations.getByUserCode(request.params.userCode)
    })

    app.post('/v1/web/device-authorizations/:userCode/approve', {
      schema: {
        params: Type.Object({ userCode: Type.String({ minLength: 8, maxLength: 20 }) }), response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await authorizations.approve(request.params.userCode, session.accountId)
      return reply.status(204).send(null)
    })

    app.post('/v1/web/device-authorizations/:userCode/deny', {
      schema: {
        params: Type.Object({ userCode: Type.String({ minLength: 8, maxLength: 20 }) }), response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await authorizations.deny(request.params.userCode)
      return reply.status(204).send(null)
    })
  }
}
