import { createHash, randomBytes } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'

export interface AccessClaims {
  accountId: string
  deviceId: string
  expiresAt: number
}

export class TokenService {
  readonly #key: Uint8Array
  readonly #issuer: string

  constructor(secret: string, issuer: string) {
    this.#key = new TextEncoder().encode(secret)
    this.#issuer = issuer
  }

  async signAccessToken(claims: Omit<AccessClaims, 'expiresAt'>): Promise<string> {
    return new SignJWT({ deviceId: claims.deviceId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.accountId)
      .setIssuer(this.#issuer)
      .setAudience('note-gen-client')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(this.#key)
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.#key, {
      issuer: this.#issuer,
      audience: 'note-gen-client',
    })
    if (payload.sub === undefined || typeof payload.deviceId !== 'string' || typeof payload.exp !== 'number') {
      throw new Error('Access token claims are incomplete')
    }
    return { accountId: payload.sub, deviceId: payload.deviceId, expiresAt: payload.exp }
  }

  createRefreshToken(): string {
    return randomBytes(32).toString('base64url')
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('base64url')
  }
}
