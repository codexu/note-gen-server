import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import type { DevicePairingService } from '../auth/device-pairing-service.js'
import type { WebSessionService } from '../auth/web-session-service.js'
import { resolveApiPublicBaseUrl } from '../development-origin.js'
import { requireCsrf, requireWebSession, WEB_CSRF_COOKIE, WEB_SESSION_COOKIE } from './web-auth.js'
import { SessionResponse, Timestamp } from './api-schemas.js'

const DeviceInput = Type.Object({
  pairingToken: Type.String({ minLength: 40, maxLength: 100 }),
  deviceId: Type.String({ format: 'uuid' }),
  deviceName: Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
  platform: Type.String({ minLength: 1, maxLength: 50, pattern: '^[A-Za-z0-9._-]+$' }),
  encryptionPublicKey: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })),
})

export function createDevicePairingRoutes(
  config: AppConfig,
  pairings: DevicePairingService,
  webSessions: WebSessionService,
  instanceId: string,
): FastifyPluginAsyncTypebox {
  return async function devicePairingRoutes(app) {
    app.post('/v1/web/device-pairings', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { response: { 201: Type.Object({
        id: Type.String({ format: 'uuid' }), pairingUri: Type.String(), expiresAt: Timestamp, expiresIn: Type.Integer(),
      }) } },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      const pairing = await pairings.create(session.accountId)
      const params = new URLSearchParams({
        server: resolveApiPublicBaseUrl(config, request),
        token: pairing.pairingToken,
        instance: instanceId,
        v: '1',
      })
      return reply.status(201).send({
        id: pairing.id,
        pairingUri: `notegen://sync/pair?${params.toString()}`,
        expiresAt: pairing.expiresAt.toISOString(),
        expiresIn: pairing.expiresIn,
      })
    })

    app.get('/v1/web/device-pairings/:id', {
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({
          status: Type.Union([Type.Literal('pending'), Type.Literal('consumed'), Type.Literal('expired')]),
          expiresAt: Timestamp,
        }) },
      },
    }, async (request) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      const result = await pairings.getStatus(request.params.id, session.accountId)
      return { ...result, expiresAt: result.expiresAt.toISOString() }
    })

    app.delete('/v1/web/device-pairings/:id', {
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 204: Type.Null() },
      },
    }, async (request, reply) => {
      const session = await requireWebSession(request.cookies[WEB_SESSION_COOKIE], webSessions)
      requireCsrf(request.headers['x-csrf-token'], request.cookies[WEB_CSRF_COOKIE], session, webSessions)
      await pairings.cancel(request.params.id, session.accountId)
      return reply.status(204).send(null)
    })

    app.post('/v1/device-pairings/exchange', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: DeviceInput, response: { 200: SessionResponse } },
    }, async (request) => {
      const { pairingToken, ...device } = request.body
      return pairings.exchange(pairingToken, device)
    })
  }
}
