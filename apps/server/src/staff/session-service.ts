import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { staffPrincipals, staffSessions } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { StaffPermission } from './permissions.js'
import { StaffService } from './service.js'
import type { AccountServiceAudit } from '../audit/service.js'

const MAX_SESSION_TTL_MS = 8 * 60 * 60 * 1_000
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000
const MAX_STEP_UP_AGE_MS = 5 * 60 * 1_000
const AUTH_STRENGTH = /^(?:password|mfa|phishing-resistant|step-up)(?:[+:][a-z0-9._-]+)*$/

/**
 * Creates short durable Staff sessions for the internal-test local edge and
 * the future OIDC edge, then rechecks the session together with principal and
 * role facts for every protected operation. Protocol and cookie handling stay
 * at their respective HTTP edges.
 */
export class StaffSessionService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly staff: StaffService,
    private readonly audit?: AccountServiceAudit,
  ) {}

  async establishVerifiedFederatedSession(input: {
    issuer: string
    subject: string
    displayName: string
    email?: string
    authStrength: string
    ttlMs?: number
  }): Promise<{ sessionId: string, staffId: string, expiresAt: Date }> {
    const authStrength = input.authStrength.trim().toLocaleLowerCase('und')
    const ttlMs = input.ttlMs ?? DEFAULT_SESSION_TTL_MS
    if (!AUTH_STRENGTH.test(authStrength) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SESSION_TTL_MS) {
      throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session assertion is invalid', statusCode: 400 })
    }
    const principal = await this.staff.upsertFederatedPrincipal(input)
    if (principal.disabled) {
      throw new ApiError({ code: 'staff_principal_disabled', message: 'Staff principal is disabled', statusCode: 403 })
    }
    const expiresAt = new Date(Date.now() + ttlMs)
    const session = await this.database.db.transaction(async (tx) => {
      const [created] = await tx.insert(staffSessions).values({
        staffId: principal.id, authStrength, expiresAt,
      }).returning({ id: staffSessions.id })
      if (created === undefined) throw new Error('Staff session insert returned no row')
      await this.audit?.recordInTransaction(tx, {
        actorType: 'staff', actorId: principal.id, action: 'staff.session.established',
        targetType: 'staff-session', targetId: created.id, metadata: { authStrength, ttlSeconds: Math.floor(ttlMs / 1_000) },
      })
      return created
    })
    return { sessionId: session.id, staffId: principal.id, expiresAt }
  }

  async establishLocalSession(staffId: string): Promise<{ sessionId: string, csrfToken: string, expiresAt: Date }> {
    const csrfToken = randomBytes(24).toString('base64url')
    const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS)
    const created = await this.database.db.transaction(async (tx) => {
      const [session] = await tx.insert(staffSessions).values({
        staffId,
        authStrength: 'password',
        csrfTokenHash: hashToken(csrfToken),
        expiresAt,
      }).returning({ id: staffSessions.id })
      if (session === undefined) throw new Error('Local Staff session insert returned no row')
      await this.audit?.recordInTransaction(tx, {
        actorType: 'staff', actorId: staffId, action: 'staff.local-session.established',
        targetType: 'staff-session', targetId: session.id, metadata: { authStrength: 'password' },
      })
      return session
    })
    return { sessionId: created.id, csrfToken, expiresAt }
  }

  async requireActiveSession(sessionId: string, permission?: StaffPermission): Promise<{
    sessionId: string
    staffId: string
    authStrength: string
    expiresAt: Date
    createdAt: Date
    csrfTokenHash: string | null
  }> {
    const [session] = await this.database.db.select({
      sessionId: staffSessions.id, staffId: staffSessions.staffId,
      authStrength: staffSessions.authStrength, expiresAt: staffSessions.expiresAt, createdAt: staffSessions.createdAt,
      csrfTokenHash: staffSessions.csrfTokenHash,
    }).from(staffSessions).innerJoin(staffPrincipals, eq(staffSessions.staffId, staffPrincipals.id)).where(and(
      eq(staffSessions.id, sessionId), isNull(staffSessions.revokedAt), gt(staffSessions.expiresAt, new Date()),
      isNull(staffPrincipals.disabledAt),
    )).limit(1)
    if (session === undefined) {
      throw new ApiError({ code: 'staff_session_invalid', message: 'Staff session is unavailable', statusCode: 401 })
    }
    if (permission !== undefined) await this.staff.requirePermission(session.staffId, permission)
    await this.database.db.update(staffSessions).set({ lastSeenAt: new Date() }).where(and(
      eq(staffSessions.id, session.sessionId), isNull(staffSessions.revokedAt), gt(staffSessions.expiresAt, new Date()),
    ))
    return session
  }

  verifyCsrf(session: { csrfTokenHash: string | null }, cookieToken: string | undefined, headerToken: string | undefined): void {
    if (session.csrfTokenHash === null || cookieToken === undefined || headerToken === undefined
      || cookieToken !== headerToken || hashToken(headerToken) !== session.csrfTokenHash) {
      throw new ApiError({ code: 'csrf_invalid', message: 'CSRF token is invalid', statusCode: 403 })
    }
  }

  /** High-impact staff actions need a fresh IdP step-up or a phishing-resistant
   * assertion in addition to their RBAC permission. The OIDC edge owns how
   * that assertion is obtained; protected routes only consume its durable
   * normalized strength. */
  async requireHighAssuranceSession(sessionId: string, permission?: StaffPermission): Promise<{
    sessionId: string
    staffId: string
    authStrength: string
    expiresAt: Date
    createdAt: Date
  }> {
    const session = await this.requireActiveSession(sessionId, permission)
    const stepUpAge = Date.now() - session.createdAt.getTime()
    const freshStepUp = session.authStrength.startsWith('step-up') && stepUpAge >= 0 && stepUpAge <= MAX_STEP_UP_AGE_MS
    if (!freshStepUp && !session.authStrength.startsWith('phishing-resistant')) {
      throw new ApiError({ code: 'staff_step_up_required', message: 'A high-assurance Staff session is required', statusCode: 403 })
    }
    return session
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [revoked] = await tx.update(staffSessions).set({ revokedAt: new Date() }).where(and(
        eq(staffSessions.id, sessionId), isNull(staffSessions.revokedAt),
      )).returning({ id: staffSessions.id, staffId: staffSessions.staffId })
      if (revoked === undefined) return
      await this.audit?.recordInTransaction(tx, {
        actorType: 'system', action: 'staff.session.revoked', targetType: 'staff-session', targetId: revoked.id,
        metadata: { staffId: revoked.staffId },
      })
    })
  }
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}
