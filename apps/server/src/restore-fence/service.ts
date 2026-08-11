import { and, eq, ne, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accountActionTokens, accounts, backgroundJobs, bootstrapCredentials, deviceAuthorizations, devicePairings, outboxMessages, refreshTokens, registrationInvitations, restoreMarkers, riskRestrictions, webSessions } from '../database/schema.js'

/**
 * Runs before HTTP/workers after a recorded restore. A restore tool must write
 * `auth_epoch_after`; failing closed is safer than serving a snapshot whose old
 * access/refresh credentials may still be usable elsewhere.
 */
export class RestoreFenceService {
  constructor(private readonly database: DatabaseContext) {}

  async reconcile(): Promise<void> {
    const markers = await this.database.db.select({ id: restoreMarkers.id, authEpochAfter: restoreMarkers.authEpochAfter })
      .from(restoreMarkers).where(ne(restoreMarkers.sanitationStatus, 'complete'))
    for (const marker of markers) {
      if (marker.authEpochAfter === null) {
        throw new Error(`Restore marker ${marker.id} has no auth_epoch_after; refusing to serve restored credentials`)
      }
      await this.database.db.transaction(async (tx) => {
        const [claimed] = await tx.update(restoreMarkers).set({ sanitationStatus: 'running' })
          .where(and(eq(restoreMarkers.id, marker.id), ne(restoreMarkers.sanitationStatus, 'complete'))).returning({ id: restoreMarkers.id })
        if (claimed === undefined) return
        await tx.update(accounts).set({ credentialEpoch: sql`greatest(${accounts.credentialEpoch}, ${marker.authEpochAfter})`, updatedAt: new Date() })
        // A backup may contain password/TOTP material that changed after its
        // cutoff. Every restored account must receive an explicit local
        // review before it can mint fresh credentials. The partial unique
        // index makes this idempotent across an interrupted sanitation retry.
        const restoredAccounts = await tx.select({ id: accounts.id }).from(accounts)
        if (restoredAccounts.length > 0) {
          await tx.insert(riskRestrictions).values(restoredAccounts.map(account => ({
            subjectType: 'account', subjectRef: account.id, scope: 'authentication', action: 'review',
            reasonCode: 'credential_review_required', source: 'automatic',
          }))).onConflictDoNothing()
        }
        const now = new Date()
        await tx.update(refreshTokens).set({ revokedAt: now }).where(sql`${refreshTokens.revokedAt} is null`)
        // Web sessions predate access-token epoch claims. Delete rather than
        // trusting a restored cookie to be invalidated by a later request.
        await tx.delete(webSessions)
        // Password-reset, email-verification, bootstrap and invitation tokens
        // are bearer credentials too. A backup may contain a token that was
        // consumed only after the snapshot; revoke every outstanding one.
        await tx.update(accountActionTokens).set({ revokedAt: now })
          .where(sql`${accountActionTokens.consumedAt} is null and ${accountActionTokens.revokedAt} is null`)
        await tx.update(bootstrapCredentials).set({ revokedAt: now })
          .where(sql`${bootstrapCredentials.consumedAt} is null and ${bootstrapCredentials.revokedAt} is null`)
        await tx.update(registrationInvitations).set({ revokedAt: now })
          .where(sql`${registrationInvitations.revokedAt} is null and ${registrationInvitations.useCount} < ${registrationInvitations.maxUses}`)
        // A pending device code is also an outstanding credential ceremony:
        // its holder can still ask a browser with a fresh session to approve
        // it after the restore. Deny every unconsumed authorization rather
        // than only already-approved ones, so recovery requires a completely
        // new device-authorization flow.
        await tx.update(deviceAuthorizations).set({ status: 'denied' }).where(sql`${deviceAuthorizations.consumedAt} is null and ${deviceAuthorizations.status} in ('pending', 'approved')`)
        await tx.delete(devicePairings).where(sql`${devicePairings.consumedAt} is null`)
        // A restored queue can contain work whose external side effect may
        // already have happened after the snapshot. The generic job enum has
        // no quarantine state, so terminalize it with an explicit reason; an
        // operator must create a new, reviewed intent to retry it.
        await tx.update(backgroundJobs).set({
          status: 'dead_letter', errorCode: 'restore_quarantined', finishedAt: now,
          lockedAt: null, lockedBy: null, leaseExpiresAt: null,
        }).where(sql`${backgroundJobs.status} in ('pending', 'running')`)
        // Sending is at-least-once and a recovered lease cannot establish
        // whether the provider accepted it. Preserve the record as unknown,
        // not pending, so the mail worker has no automatic retry path.
        await tx.update(outboxMessages).set({
          status: 'delivery_unknown', lastErrorCode: 'restore_quarantined',
          lockedAt: null, lockedBy: null, leaseExpiresAt: null,
        }).where(sql`${outboxMessages.status} in ('pending', 'sending')`)
        await tx.update(restoreMarkers).set({ sanitationStatus: 'complete', completedAt: new Date() })
          .where(eq(restoreMarkers.id, marker.id))
      })
    }
  }
}
