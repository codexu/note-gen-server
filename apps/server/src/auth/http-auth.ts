import type { FastifyRequest } from 'fastify'
import { ApiError } from '../errors.js'
import type { TokenService, AccessClaims } from './tokens.js'
import type { AuthService } from './service.js'

export async function requireAuth(
  request: FastifyRequest,
  tokens: TokenService,
  auth?: AuthService,
): Promise<AccessClaims> {
  const authorization = request.headers.authorization
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    throw new ApiError({ code: 'unauthorized', message: 'Authentication required', statusCode: 401 })
  }

  try {
    const claims = await tokens.verifyAccessToken(authorization.slice('Bearer '.length))
    await auth?.assertDeviceActive(claims.accountId, claims.deviceId)
    return claims
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError({ code: 'unauthorized', message: 'Access token is invalid or expired', statusCode: 401 })
  }
}
