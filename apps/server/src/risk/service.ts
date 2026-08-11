import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { accounts, riskEvents, riskRestrictions } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { StaffService } from '../staff/service.js'
import type { AccountServiceAudit } from '../audit/service.js'

export type RiskScope = 'sync_write' | 'blob' | 'authentication' | 'registration' | 'recovery' | 'device' | 'billing'
export interface ActiveRiskRestriction {
  scope: RiskScope | 'all'
  action: 'deny' | 'challenge' | 'lock' | 'read_only' | 'review'
  reasonCode: string
  expiresAt: string | null
}

export type StaffRiskScope = RiskScope | 'all'
export type StaffRiskAction = ActiveRiskRestriction['action']

/** Reads durable restrictions only; provider scoring and staff management are separate slices. */
export class RiskService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly auditSecret: string,
    private readonly config?: AppConfig,
    private readonly staff?: StaffService,
    private readonly audit?: AccountServiceAudit,
  ) {}

  /**
   * Writes only pseudonymous request signals. This is intentionally best-effort
   * at callers so authentication availability never depends on audit storage.
   */
  async recordEvent(input: {
    eventType: 'authentication.login' | 'authentication.registration'
    login: string
    requestId: string
    ip: string
    userAgent?: string
    deviceId?: string
    accountId?: string
    outcome: 'allowed' | 'rejected'
    reasonCode?: string
  }): Promise<void> {
    await this.database.db.insert(riskEvents).values({
      eventType: input.eventType,
      accountId: input.accountId,
      identityHash: this.digest('identity:v1', input.login.trim().toLowerCase()),
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      ipPrefixHash: this.digest('ip-prefix:v1', prefixForAudit(input.ip)),
      ...(input.userAgent === undefined ? {} : { userAgentFamily: userAgentFamily(input.userAgent) }),
      requestId: input.requestId,
      outcome: input.outcome,
      reasonCodes: input.reasonCode === undefined ? [] : [input.reasonCode],
      metadata: {},
    })
  }

  /** Independent distributed buckets for identity entry points. Their keys are
   * HMACs, so `rate_limit_buckets` never persists raw IP or login values. */
  async enforceIdentityAttempt(input: { action: 'registration' | 'login', ip: string, login: string, deviceId?: string }): Promise<void> {
    const windowMs = 60_000
    const max = input.action === 'registration' ? 5 : 10
    const now = Date.now()
    const windowStart = new Date(Math.floor(now / windowMs) * windowMs)
    const expiresAt = new Date(windowStart.getTime() + windowMs)
    const normalizedLogin = input.login.trim().toLocaleLowerCase('und') || 'unknown'
    const keys: Array<readonly [string, string]> = [
      ['ip_prefix', prefixForAudit(input.ip)],
      ['identity', normalizedLogin],
      ['ip_identity', `${prefixForAudit(input.ip)}:${normalizedLogin}`],
      ...(input.deviceId === undefined ? [] : [['device', input.deviceId]] as const),
    ]
    let highest = 0
    for (const [dimension, value] of keys) {
      const rateKey = this.digest(`risk-rate:${input.action}:${dimension}:v1`, value)
      const [row] = await this.database.sql<Array<{ hits: number }>>`
        insert into rate_limit_buckets (scope, rate_key, window_start, expires_at, hits)
        values (${`risk:${input.action}:${dimension}`}, ${rateKey}, ${windowStart.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz, 1)
        on conflict (scope, rate_key, window_start) do update set hits = rate_limit_buckets.hits + 1
        returning hits`
      highest = Math.max(highest, row?.hits ?? 0)
    }
    if (highest > max) {
      throw new ApiError({ code: 'rate_limited', message: 'Too many authentication attempts', statusCode: 429, retryable: true,
        details: { retryAfterSeconds: Math.ceil(Math.max(0, expiresAt.getTime() - now) / 1_000) } })
    }
  }

  async enforceAccount(accountId: string, scope: RiskScope): Promise<void> {
    await this.enforceAccountWithExecutor(this.database.db, accountId, scope)
  }

  /** A read-only restriction must not prevent a user from retrieving their
   * own data, while stronger safety decisions still protect high-volume reads. */
  async enforceAccountRead(accountId: string, scope: RiskScope): Promise<void> {
    await this.enforceAccountWithExecutor(this.database.db, accountId, scope, true)
  }

  /** Uses a caller-owned transaction for credential issuance paths. This
   * avoids acquiring a second pool connection while a refresh-token row is
   * locked, which would deadlock when a self-hosted instance has pool size 1. */
  async enforceAccountInTransaction(tx: any, accountId: string, scope: RiskScope): Promise<void> {
    await this.enforceAccountWithExecutor(tx, accountId, scope)
  }

  private async enforceAccountWithExecutor(executor: any, accountId: string, scope: RiskScope, readOnly = false): Promise<void> {
    const restrictions = await this.getActiveRestrictionsFrom(executor, accountId)
    const applicable = restrictions.filter(restriction => (restriction.scope === scope || restriction.scope === 'all')
      && (!readOnly || restriction.action !== 'read_only'))
    const restriction = chooseStrictest(applicable)
    if (restriction === undefined) return
    const details = { reasonCode: restriction.reasonCode, ...(restriction.expiresAt === null ? {} : { expiresAt: restriction.expiresAt }) }
    switch (restriction.action) {
      case 'deny': throw new ApiError({ code: 'risk_denied', message: 'This operation is restricted for account safety', statusCode: 403, details })
      case 'challenge': throw new ApiError({ code: 'risk_challenge_required', message: 'Additional verification is required', statusCode: 403, details })
      case 'lock': throw new ApiError({ code: 'risk_temporarily_locked', message: 'Account activity is temporarily locked', statusCode: 423, details })
      case 'read_only': throw new ApiError({ code: 'account_read_only', message: 'Account is temporarily read-only', statusCode: 423, details })
      case 'review':
        if (restriction.reasonCode === 'credential_review_required') {
          throw new ApiError({ code: 'credential_review_required', message: 'Restored credentials require operator review', statusCode: 423, details })
        }
        throw new ApiError({ code: 'risk_review_required', message: 'Account activity requires review', statusCode: 423, details })
    }
  }

  /** Minimal account-owned projection for UI/diagnostics; enforcement remains server-side. */
  async getActiveRestrictions(accountId: string): Promise<ActiveRiskRestriction[]> {
    return await this.getActiveRestrictionsFrom(this.database.db, accountId)
  }

  /** Internal-test operator control. Staff authority is deliberately distinct
   * from the legacy self-hosted `created_by` customer-admin attribution. */
  async upsertStaffAccountRestriction(input: {
    actorStaffId: string
    accountId: string
    scope: StaffRiskScope
    action: StaffRiskAction
    reasonCode: string
    expiresAt: Date | null
    requestId?: string
  }): Promise<{ id: string, created: boolean }> {
    this.assertStaffManagementAvailable()
    if (!/^[a-z0-9._-]{3,100}$/.test(input.reasonCode)
      || (input.expiresAt !== null && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date()))) {
      throw new ApiError({ code: 'risk_restriction_invalid', message: 'Risk restriction is invalid', statusCode: 400 })
    }
    await this.staff!.requirePermission(input.actorStaffId, 'risk.manage')
    if (input.action === 'deny' || input.action === 'lock' || input.expiresAt === null) {
      await this.staff!.requirePermission(input.actorStaffId, 'risk.admin')
    }
    return await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-risk:${input.accountId}`}))`)
      const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.accountId)).limit(1).for('update')
      if (account === undefined) throw new ApiError({ code: 'account_not_found', message: 'Account was not found', statusCode: 404 })
      const [existing] = await tx.select({ id: riskRestrictions.id, reasonCode: riskRestrictions.reasonCode, expiresAt: riskRestrictions.expiresAt }).from(riskRestrictions).where(and(
        eq(riskRestrictions.subjectType, 'account'), eq(riskRestrictions.subjectRef, input.accountId),
        eq(riskRestrictions.scope, input.scope), eq(riskRestrictions.action, input.action), isNull(riskRestrictions.revokedAt),
      )).limit(1).for('update')
      const [restriction] = existing === undefined
        ? await tx.insert(riskRestrictions).values({
            subjectType: 'account', subjectRef: input.accountId, scope: input.scope, action: input.action,
            reasonCode: input.reasonCode, source: 'staff', expiresAt: input.expiresAt, createdByStaffId: input.actorStaffId,
          }).returning({ id: riskRestrictions.id })
        : await tx.update(riskRestrictions).set({
            reasonCode: input.reasonCode, expiresAt: input.expiresAt, createdByStaffId: input.actorStaffId,
          }).where(eq(riskRestrictions.id, existing.id)).returning({ id: riskRestrictions.id })
      if (restriction === undefined) throw new Error('Risk restriction write returned no row')
      await this.audit?.recordInTransaction(tx, {
        actorType: 'staff', actorId: input.actorStaffId,
        action: existing === undefined ? 'risk.restriction.create' : 'risk.restriction.update',
        targetType: 'account', targetId: input.accountId, requestId: input.requestId,
        metadata: { restrictionId: restriction.id, scope: input.scope, restrictionAction: input.action, reasonCode: input.reasonCode, expiresAt: input.expiresAt?.toISOString() ?? null },
      })
      return { id: restriction.id, created: existing === undefined }
    })
  }

  async revokeStaffAccountRestriction(input: { actorStaffId: string, restrictionId: string, requestId?: string }): Promise<void> {
    this.assertStaffManagementAvailable()
    await this.staff!.requirePermission(input.actorStaffId, 'risk.manage')
    await this.database.db.transaction(async (tx) => {
      const [restriction] = await tx.select({ id: riskRestrictions.id, subjectRef: riskRestrictions.subjectRef, action: riskRestrictions.action, source: riskRestrictions.source })
        .from(riskRestrictions).where(and(eq(riskRestrictions.id, input.restrictionId), eq(riskRestrictions.subjectType, 'account'), isNull(riskRestrictions.revokedAt))).limit(1).for('update')
      if (restriction === undefined) throw new ApiError({ code: 'risk_restriction_not_found', message: 'Active risk restriction was not found', statusCode: 404 })
      if (restriction.action === 'deny' || restriction.action === 'lock' || restriction.source !== 'staff') {
        await this.staff!.requirePermission(input.actorStaffId, 'risk.admin')
      }
      await tx.update(riskRestrictions).set({ revokedAt: new Date(), revokedByStaffId: input.actorStaffId })
        .where(eq(riskRestrictions.id, restriction.id))
      await this.audit?.recordInTransaction(tx, {
        actorType: 'staff', actorId: input.actorStaffId, action: 'risk.restriction.revoke',
        targetType: 'account', targetId: restriction.subjectRef, requestId: input.requestId,
        metadata: { restrictionId: restriction.id, restrictionAction: restriction.action, source: restriction.source },
      })
    })
  }

  private async getActiveRestrictionsFrom(executor: any, accountId: string): Promise<ActiveRiskRestriction[]> {
    const restrictions = await executor.select({ scope: riskRestrictions.scope, action: riskRestrictions.action, reasonCode: riskRestrictions.reasonCode, expiresAt: riskRestrictions.expiresAt })
      .from(riskRestrictions).where(and(
        eq(riskRestrictions.subjectType, 'account'), eq(riskRestrictions.subjectRef, accountId),
        isNull(riskRestrictions.revokedAt), or(isNull(riskRestrictions.expiresAt), gt(riskRestrictions.expiresAt, new Date())),
      ))
    return restrictions.map((restriction: { scope: string, action: string, reasonCode: string, expiresAt: Date | null }) => ({
      scope: restriction.scope as ActiveRiskRestriction['scope'],
      action: restriction.action as ActiveRiskRestriction['action'],
      reasonCode: restriction.reasonCode,
      expiresAt: restriction.expiresAt?.toISOString() ?? null,
    }))
  }

  private assertStaffManagementAvailable(): void {
    if (this.config?.deploymentMode !== 'hosted' || this.config.hostedReleaseStage !== 'internal-test' || this.staff === undefined) {
      throw new ApiError({ code: 'risk_management_internal_test_only', message: 'Risk management is not available in this deployment', statusCode: 403 })
    }
  }

  private digest(namespace: string, value: string): string {
    return `v1:${createHmac('sha256', this.auditSecret).update(`${namespace}:${value}`).digest('base64url')}`
  }
}

function prefixForAudit(ip: string): string {
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`
  if (isIP(ip) === 6) return `${ip.split(':').slice(0, 4).join(':')}::/64`
  return 'unavailable'
}

function userAgentFamily(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized.includes('edg/')) return 'edge'
  if (normalized.includes('firefox/')) return 'firefox'
  if (normalized.includes('chrome/') || normalized.includes('chromium/')) return 'chromium'
  if (normalized.includes('safari/')) return 'safari'
  if (normalized.includes('notegen')) return 'notegen'
  return 'other'
}

function chooseStrictest<T extends { action: string }>(restrictions: T[]): T | undefined {
  const weight: Record<string, number> = { review: 1, challenge: 2, read_only: 3, lock: 4, deny: 5 }
  return restrictions.reduce<T | undefined>((current, next) => current === undefined || weight[next.action] > weight[current.action] ? next : current, undefined)
}
