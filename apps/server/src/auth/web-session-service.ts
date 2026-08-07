import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accounts, webSessions } from '../database/schema.js'
import { ApiError } from '../errors.js'

export interface WebSessionResult {
  sessionToken: string
  csrfToken: string
  expiresAt: Date
}

export interface WebAccountSession {
  sessionId: string
  accountId: string
  login: string
  isAdmin: boolean
  csrfTokenHash: string
}

export class WebSessionService {
  constructor(private readonly database: DatabaseContext) {}

  async create(accountId: string, context?: { ip?: string, userAgent?: string }): Promise<WebSessionResult> {
    const sessionToken = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(24).toString('base64url')
    const expiresAt = addDays(new Date(), 30)
    await this.database.db.insert(webSessions).values({
      accountId,
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      expiresAt,
      lastIp: context?.ip ?? null,
      userAgent: context?.userAgent?.slice(0, 500) ?? null,
    })
    return { sessionToken, csrfToken, expiresAt }
  }

  async authenticate(sessionToken: string | undefined): Promise<WebAccountSession> {
    if (sessionToken === undefined || sessionToken.length < 20) {
      throw new ApiError({ code: 'web_session_required', message: 'Web session is required', statusCode: 401 })
    }
    const [session] = await this.database.db.select({
      id: webSessions.id,
      accountId: webSessions.accountId,
      login: accounts.login,
      isAdmin: accounts.isAdmin,
      csrfTokenHash: webSessions.csrfTokenHash,
      lastIp: webSessions.lastIp,
    }).from(webSessions).innerJoin(accounts, eq(accounts.id, webSessions.accountId)).where(and(
      eq(webSessions.tokenHash, hashToken(sessionToken)),
      gt(webSessions.expiresAt, new Date()),
      isNull(accounts.suspendedAt),
      isNull(accounts.disabledAt),
    )).limit(1)
    if (session === undefined) {
      throw new ApiError({ code: 'web_session_invalid', message: 'Web session is invalid or expired', statusCode: 401 })
    }
    const now = new Date()
    await this.database.db.update(webSessions).set({ lastSeenAt: now }).where(and(
      eq(webSessions.id, session.id),
      lt(webSessions.lastSeenAt, new Date(now.getTime() - 5 * 60 * 1_000)),
    ))
    return {
      sessionId: session.id,
      accountId: session.accountId,
      login: session.login,
      isAdmin: session.isAdmin,
      csrfTokenHash: session.csrfTokenHash,
    }
  }

  async listForAccount(accountId: string, currentSessionId: string) {
    const rows = await this.database.db.select({
      id: webSessions.id,
      expiresAt: webSessions.expiresAt,
      lastSeenAt: webSessions.lastSeenAt,
      lastIp: webSessions.lastIp,
      userAgent: webSessions.userAgent,
      createdAt: webSessions.createdAt,
    }).from(webSessions).where(eq(webSessions.accountId, accountId)).orderBy(webSessions.lastSeenAt)
    return rows.map((row) => ({ ...row, current: row.id === currentSessionId }))
  }

  async destroyOthers(accountId: string, currentSessionId: string): Promise<number> {
    const removed = await this.database.db.delete(webSessions).where(and(
      eq(webSessions.accountId, accountId),
      sql`${webSessions.id} <> ${currentSessionId}`,
    )).returning({ id: webSessions.id })
    return removed.length
  }

  async destroy(sessionToken: string | undefined): Promise<void> {
    if (sessionToken === undefined) return
    await this.database.db.delete(webSessions).where(eq(webSessions.tokenHash, hashToken(sessionToken)))
  }

  async destroyForAccount(accountId: string): Promise<void> {
    await this.database.db.delete(webSessions).where(eq(webSessions.accountId, accountId))
  }

  verifyCsrf(session: WebAccountSession, cookieToken: string | undefined, headerToken: string | undefined): void {
    if (cookieToken === undefined || headerToken === undefined || cookieToken !== headerToken
      || hashToken(headerToken) !== session.csrfTokenHash) {
      throw new ApiError({ code: 'csrf_invalid', message: 'CSRF token is invalid', statusCode: 403 })
    }
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000)
}
