import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import {
  accountActionTokens, accountDeletionCases, accountDeletionFences, accounts, deletionCaseSteps, deviceAuthorizations, devicePairings, devices, refreshTokens, webSessions, workspaces,
} from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { LegalHoldService } from './legal-hold-service.js'
import type { UsageService } from '../usage/service.js'
import type { RiskService } from '../risk/service.js'

export interface DeletionRequestResult {
  caseId: string
  status: 'cooling_off' | 'held'
  cancelUntil: Date
  purgeAfter: Date
  /** Returned once to the authenticated caller; only its HMAC is persisted. */
  cancelToken: string
}

/** Durable cooling-off fence. Purge handlers and restore reconciliation are added separately. */
export class DeletionService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly legalHolds?: LegalHoldService,
    private readonly usage?: UsageService,
    private readonly risk?: RiskService,
  ) {}

  async request(accountId: string, password: string): Promise<DeletionRequestResult> {
    this.assertInternalHosted()
    const requestedAt = new Date()
    const cancelUntil = addDays(requestedAt, this.config.accountDeletionCoolingOffDays)
    // The cooling-off window governs cancellation only. Physical cleanup is
    // deliberately held until the separately configured retention boundary.
    const purgeAfter = addDays(requestedAt, this.config.accountDeletionRetentionDays)
    const cancelToken = randomBytes(32).toString('base64url')
    const cancelCredentialHash = this.hashCancelToken(cancelToken)
    return await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${accountId}`}))`)
      const [account] = await tx.select({ id: accounts.id, passwordHash: accounts.passwordHash, isAdmin: accounts.isAdmin, disabledAt: accounts.disabledAt })
        .from(accounts).where(eq(accounts.id, accountId)).limit(1)
      if (account === undefined || account.disabledAt !== null || !await argon2.verify(account.passwordHash, password)) {
        throw new ApiError({ code: 'credentials_invalid', message: 'Current password is invalid', statusCode: 401 })
      }
      await this.risk?.enforceAccountInTransaction(tx, accountId, 'authentication')
      const [existing] = await tx.select({ id: accountDeletionCases.id, status: accountDeletionCases.status })
        .from(accountDeletionCases).where(and(eq(accountDeletionCases.accountId, accountId), inArray(accountDeletionCases.status, ['requested', 'cooling_off', 'scheduled', 'held', 'purging']))).limit(1)
      if (existing !== undefined) throw new ApiError({ code: 'account_deletion_in_progress', message: 'Account deletion is already in progress', statusCode: 409, details: { caseId: existing.id, status: existing.status } })
      if (account.isAdmin) {
        const [otherAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
          eq(accounts.isAdmin, true), isNull(accounts.suspendedAt), isNull(accounts.disabledAt), sql`${accounts.id} <> ${accountId}`,
        )).limit(1)
        if (otherAdmin === undefined) throw new ApiError({ code: 'last_admin_delete_forbidden', message: 'The last active administrator cannot request account deletion', statusCode: 409 })
      }
      const held = await this.legalHolds?.hasActive(accountId) ?? false
      const subjectHash = this.subjectHash(accountId)
      const [created] = await tx.insert(accountDeletionCases).values({
        accountId, subjectHash, status: held ? 'held' : 'cooling_off', requestedAt, cancelUntil, purgeAfter, cancelCredentialHash,
      }).returning({ id: accountDeletionCases.id })
      if (created === undefined) throw new Error('Deletion case insert returned no row')
      await tx.insert(deletionCaseSteps).values(['workspace_blob', 'support_content', 'identity'].map((handler) => ({
        deletionCaseId: created.id, handler, idempotencyKey: `${created.id}:v1:${handler}`,
      })))
      await tx.insert(accountDeletionFences).values({ accountUuid: accountId, subjectHash, state: 'cooling_off', blocksDomainWrites: true })
        .onConflictDoUpdate({ target: accountDeletionFences.accountUuid, set: { subjectHash, state: 'cooling_off', blocksDomainWrites: true, updatedAt: requestedAt, completedAt: null } })
      await tx.update(accounts).set({ disabledAt: requestedAt, credentialEpoch: sql`${accounts.credentialEpoch} + 1`, updatedAt: requestedAt }).where(eq(accounts.id, accountId))
      await tx.update(devices).set({ revokedAt: requestedAt, updatedAt: requestedAt }).where(eq(devices.accountId, accountId))
      await tx.update(refreshTokens).set({ revokedAt: requestedAt }).where(eq(refreshTokens.accountId, accountId))
      // These are bearer credentials or authorization artifacts. A later
      // cancellation must not make anything minted before this request usable.
      await tx.delete(webSessions).where(eq(webSessions.accountId, accountId))
      await tx.update(accountActionTokens).set({ revokedAt: requestedAt }).where(and(
        eq(accountActionTokens.accountId, accountId), isNull(accountActionTokens.consumedAt), isNull(accountActionTokens.revokedAt),
      ))
      await tx.update(deviceAuthorizations).set({ status: 'denied' }).where(and(
        eq(deviceAuthorizations.accountId, accountId), isNull(deviceAuthorizations.consumedAt),
      ))
      await tx.delete(devicePairings).where(and(eq(devicePairings.accountId, accountId), isNull(devicePairings.consumedAt)))
      await tx.update(workspaces).set({ deletedAt: requestedAt, updatedAt: requestedAt }).where(eq(workspaces.accountId, accountId))
      await this.usage?.reconcileCurrentInTransaction(tx, accountId)
      return { caseId: created.id, status: held ? 'held' as const : 'cooling_off' as const, cancelUntil, purgeAfter, cancelToken }
    })
  }

  async cancel(caseId: string, token: string): Promise<{ status: 'canceled' }> {
    this.assertInternalHosted()
    const tokenHash = this.hashCancelToken(token)
    return await this.database.db.transaction(async (tx) => {
      const [caseRow] = await tx.select().from(accountDeletionCases).where(eq(accountDeletionCases.id, caseId)).limit(1)
      if (caseRow === undefined || caseRow.accountId === null || caseRow.cancelCredentialHash === null
        || !safeEqual(caseRow.cancelCredentialHash, tokenHash)) {
        throw new ApiError({ code: 'deletion_cancel_invalid', message: 'Deletion cancellation credential is invalid', statusCode: 403 })
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${caseRow.accountId}`}))`)
      if (!['cooling_off', 'held'].includes(caseRow.status) || caseRow.cancelUntil === null || caseRow.cancelUntil <= new Date()) {
        throw new ApiError({ code: 'deletion_cancel_unavailable', message: 'Deletion can no longer be canceled', statusCode: 409 })
      }
      const changed = await tx.update(accountDeletionCases).set({ status: 'canceled', cancelCredentialHash: null }).where(and(
        eq(accountDeletionCases.id, caseId), sql`${accountDeletionCases.status} in ('cooling_off', 'held')`,
      )).returning({ id: accountDeletionCases.id })
      if (changed.length === 0) throw new ApiError({ code: 'deletion_cancel_unavailable', message: 'Deletion can no longer be canceled', statusCode: 409 })
      await tx.update(accountDeletionFences).set({ state: 'canceled', blocksDomainWrites: false, generation: sql`gen_random_uuid()`, updatedAt: new Date() }).where(eq(accountDeletionFences.accountUuid, caseRow.accountId))
      await tx.update(accounts).set({ disabledAt: null, credentialEpoch: sql`${accounts.credentialEpoch} + 1`, updatedAt: new Date() }).where(eq(accounts.id, caseRow.accountId))
      await tx.update(workspaces).set({ deletedAt: null, updatedAt: new Date() }).where(eq(workspaces.accountId, caseRow.accountId))
      await this.usage?.reconcileCurrentInTransaction(tx, caseRow.accountId)
      return { status: 'canceled' as const }
    })
  }

  private assertInternalHosted(): void {
    if (this.config.deploymentMode !== 'hosted' || this.config.hostedReleaseStage !== 'internal-test') {
      throw new ApiError({ code: 'deletion_internal_test_only', message: 'Deletion cases are not available in this deployment', statusCode: 403 })
    }
  }

  private subjectHash(accountId: string): string {
    return createHmac('sha256', this.config.authSecret).update(`compliance-subject:v1:${accountId}`).digest('base64url')
  }

  private hashCancelToken(token: string): string {
    return createHmac('sha256', this.config.authSecret).update(`deletion-cancel:v1:${token}`).digest('base64url')
  }
}

function addDays(date: Date, days: number): Date { return new Date(date.getTime() + days * 86_400_000) }

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
