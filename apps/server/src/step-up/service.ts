import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { stepUpGrants, webSessions } from '../database/schema.js'
import { ApiError } from '../errors.js'

const DEFAULT_TTL_SECONDS = 5 * 60

export class WebStepUpService {
  constructor(private readonly database: DatabaseContext, private readonly digestSecret: string) {}

  requestHash(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('base64url')
  }

  async issueAccountGrant(input: {
    accountId: string
    sessionId: string
    audience: string
    requestHash: string
    authMethods: string[]
  }): Promise<{ token: string, expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_SECONDS * 1_000)
    await this.database.db.insert(stepUpGrants).values({
      tokenDigest: this.digest(token), digestKeyId: 'auth-secret-v1', actorType: 'account',
      actorId: input.accountId, sessionId: input.sessionId, actionAudience: input.audience,
      authMethods: input.authMethods, requestHash: input.requestHash, expiresAt,
    })
    return { token, expiresAt }
  }

  async consumeAccountGrant(input: {
    token: string | undefined
    accountId: string
    sessionId: string
    audience: string
    requestHash: string
  }): Promise<void> {
    if (input.token === undefined || input.token.length < 20) {
      throw new ApiError({ code: 'step_up_required', message: 'A recent step-up grant is required', statusCode: 428 })
    }
    const digest = this.digest(input.token)
    await this.database.db.transaction(async (tx) => {
      const [grant] = await tx.select().from(stepUpGrants).where(and(
        eq(stepUpGrants.tokenDigest, digest), eq(stepUpGrants.actorType, 'account'),
        eq(stepUpGrants.actorId, input.accountId), eq(stepUpGrants.sessionId, input.sessionId),
        eq(stepUpGrants.actionAudience, input.audience), eq(stepUpGrants.requestHash, input.requestHash),
        gt(stepUpGrants.expiresAt, new Date()), isNull(stepUpGrants.consumedAt), isNull(stepUpGrants.revokedAt),
      )).limit(1).for('update')
      if (grant === undefined || !timingSafeEqual(Buffer.from(grant.tokenDigest), Buffer.from(digest))) {
        throw new ApiError({ code: 'step_up_required', message: 'A valid step-up grant is required', statusCode: 428 })
      }
      const [session] = await tx.select({ id: webSessions.id }).from(webSessions).where(and(
        eq(webSessions.id, input.sessionId), eq(webSessions.accountId, input.accountId), gt(webSessions.expiresAt, new Date()),
      )).limit(1).for('update')
      if (session === undefined) throw new ApiError({ code: 'step_up_required', message: 'A valid step-up grant is required', statusCode: 428 })
      await tx.update(stepUpGrants).set({ consumedAt: new Date() }).where(eq(stepUpGrants.id, grant.id))
    })
  }

  private digest(token: string): string {
    return createHmac('sha256', this.digestSecret).update(token).digest('base64url')
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Step-up request cannot contain a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`
  }
  throw new Error('Step-up request contains an unsupported value')
}
