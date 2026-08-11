import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'

export interface AccessClaims {
  accountId: string
  deviceId: string
  credentialEpoch: string
  /** Absent only during the pre-enforcement compatibility window. */
  instanceAuthEpoch?: string
  issuedAt?: number
  expiresAt: number
}

export class TokenService {
  readonly #key: Uint8Array
  readonly #issuer: string

  constructor(secret: string, issuer: string) {
    this.#key = new TextEncoder().encode(secret)
    this.#issuer = issuer
  }

  async signAccessToken(claims: Omit<AccessClaims, 'expiresAt' | 'issuedAt'>): Promise<string> {
    return new SignJWT({ deviceId: claims.deviceId, credentialEpoch: claims.credentialEpoch, instanceAuthEpoch: claims.instanceAuthEpoch })
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
    if (payload.sub === undefined || typeof payload.deviceId !== 'string' || typeof payload.credentialEpoch !== 'string'
      || typeof payload.exp !== 'number'
      || (payload.instanceAuthEpoch !== undefined && typeof payload.instanceAuthEpoch !== 'string')
      || (payload.iat !== undefined && typeof payload.iat !== 'number')) {
      throw new Error('Access token claims are incomplete')
    }
    return { accountId: payload.sub, deviceId: payload.deviceId, credentialEpoch: payload.credentialEpoch,
      ...(typeof payload.instanceAuthEpoch === 'string' ? { instanceAuthEpoch: payload.instanceAuthEpoch } : {}),
      ...(typeof payload.iat === 'number' ? { issuedAt: payload.iat } : {}), expiresAt: payload.exp }
  }

  createRefreshToken(): string {
    return randomBytes(32).toString('base64url')
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('base64url')
  }

  sealRefreshRecovery(value: string, aad: string): string {
    const iv = randomBytes(12); const key = createHash('sha256').update(this.#key).update('refresh-recovery-v1').digest()
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(aad))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`
  }

  openRefreshRecovery(value: string, aad: string): string | null {
    const [iv, ciphertext, tag, ...extra] = value.split('.')
    if (!iv || !ciphertext || !tag || extra.length !== 0) return null
    try {
      const key = createHash('sha256').update(this.#key).update('refresh-recovery-v1').digest()
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
    } catch { return null }
  }
}
