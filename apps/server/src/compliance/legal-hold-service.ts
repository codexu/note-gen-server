import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { accountDeletionCases, accountDeletionFences, legalHolds } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { StaffService } from '../staff/service.js'
import type { AccountServiceAudit } from '../audit/service.js'

/** Legal retention authority belongs to the independent Staff realm, never a customer account. */
export class LegalHoldService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly staff: StaffService,
    private readonly audit?: AccountServiceAudit,
  ) {}

  async place(accountId: string, actorStaffId: string, reasonCode: string): Promise<{ id: string, created: boolean }> {
    this.assertInternalHosted()
    if (!/^[a-z0-9._-]{3,100}$/.test(reasonCode)) throw new ApiError({ code: 'legal_hold_reason_invalid', message: 'Legal hold reason code is invalid', statusCode: 400 })
    await this.assertLegalHoldAuthority(actorStaffId)
    return await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${accountId}`}))`)
      const [existing] = await tx.select({ id: legalHolds.id, reasonCode: legalHolds.reasonCode }).from(legalHolds).where(and(
        eq(legalHolds.accountId, accountId), isNull(legalHolds.releasedAt),
      )).limit(1)
      if (existing !== undefined) {
        if (existing.reasonCode !== reasonCode) throw new ApiError({ code: 'legal_hold_active', message: 'An active legal hold already exists', statusCode: 409 })
        return { id: existing.id, created: false }
      }
      const [created] = await tx.insert(legalHolds).values({ accountId, reasonCode, authority: 'staff', approvedByStaffId: actorStaffId }).returning({ id: legalHolds.id })
      if (created === undefined) throw new Error('Legal hold insert returned no row')
      await tx.update(accountDeletionCases).set({ status: 'held' }).where(and(
        eq(accountDeletionCases.accountId, accountId), inArray(accountDeletionCases.status, ['cooling_off', 'scheduled']),
      ))
      await tx.update(accountDeletionFences).set({
        holdRevision: sql`${accountDeletionFences.holdRevision} + 1`, updatedAt: new Date(),
      }).where(eq(accountDeletionFences.accountUuid, accountId))
      await this.audit?.recordInTransaction(tx, {
        actorType: 'staff', actorId: actorStaffId, action: 'legal-hold.place', targetType: 'account', targetId: accountId,
        metadata: { holdId: created.id, reasonCode, authority: 'staff' },
      })
      return { id: created.id, created: true }
    })
  }

  async release(holdId: string, actorStaffId: string, reasonCode: string): Promise<void> {
    this.assertInternalHosted()
    if (!/^[a-z0-9._-]{3,100}$/.test(reasonCode)) throw new ApiError({ code: 'legal_hold_reason_invalid', message: 'Legal hold reason code is invalid', statusCode: 400 })
    await this.assertLegalHoldAuthority(actorStaffId)
    await this.database.db.transaction(async (tx) => {
      // Take the hold row first so its account identity cannot change beneath
      // the subject lock decision, then serialize release with every deletion
      // transition/handler that uses the same account-scoped lock.
      const [candidate] = await tx.select({ accountId: legalHolds.accountId }).from(legalHolds).where(and(
        eq(legalHolds.id, holdId), isNull(legalHolds.releasedAt),
      )).limit(1).for('update')
      if (candidate === undefined) throw new ApiError({ code: 'legal_hold_not_active', message: 'Legal hold is not active', statusCode: 409 })
      if (candidate.accountId !== null) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${candidate.accountId}`}))`)
      }
      const [hold] = await tx.update(legalHolds).set({
        releasedByStaffId: actorStaffId, releasedAt: new Date(), releaseReasonCode: reasonCode,
      }).where(and(eq(legalHolds.id, holdId), isNull(legalHolds.releasedAt))).returning({ accountId: legalHolds.accountId })
      if (hold === undefined) throw new ApiError({ code: 'legal_hold_not_active', message: 'Legal hold is not active', statusCode: 409 })
      if (hold.accountId !== null) {
        const [caseRow] = await tx.select({ id: accountDeletionCases.id, purgeAfter: accountDeletionCases.purgeAfter }).from(accountDeletionCases).where(and(
          eq(accountDeletionCases.accountId, hold.accountId), eq(accountDeletionCases.status, 'held'),
        )).limit(1)
        if (caseRow !== undefined) {
          // A released hold restores the deletion timeline; it never shortens
          // the separately configured retention period to the cancel window.
          const status = caseRow.purgeAfter !== null && caseRow.purgeAfter <= new Date() ? 'scheduled' : 'cooling_off'
          await tx.update(accountDeletionCases).set({ status }).where(eq(accountDeletionCases.id, caseRow.id))
          await tx.update(accountDeletionFences).set({
            state: status, holdRevision: sql`${accountDeletionFences.holdRevision} + 1`, updatedAt: new Date(),
          }).where(eq(accountDeletionFences.accountUuid, hold.accountId))
        }
      }
      await this.audit?.recordInTransaction(tx, {
        actorType: 'staff', actorId: actorStaffId, action: 'legal-hold.release', targetType: 'account',
        ...(hold.accountId === null ? {} : { targetId: hold.accountId }),
        metadata: { holdId, reasonCode, authority: 'staff' },
      })
    })
  }

  async hasActive(accountId: string): Promise<boolean> {
    const [hold] = await this.database.db.select({ id: legalHolds.id }).from(legalHolds).where(and(
      eq(legalHolds.accountId, accountId), isNull(legalHolds.releasedAt),
    )).limit(1)
    return hold !== undefined
  }

  private async assertLegalHoldAuthority(staffId: string): Promise<void> {
    await this.staff.requirePermission(staffId, 'legal_hold.manage')
    await this.staff.requirePermission(staffId, 'legal_hold.approve')
  }

  private assertInternalHosted(): void {
    if (this.config.deploymentMode !== 'hosted' || this.config.hostedReleaseStage !== 'internal-test') {
      throw new ApiError({ code: 'legal_hold_internal_test_only', message: 'Legal hold controls are not available in this deployment', statusCode: 403 })
    }
  }
}
