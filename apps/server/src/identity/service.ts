import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accountIdentities, accountLoginClaimConflicts, accountLoginClaims, accounts } from '../database/schema.js'

/**
 * Additive legacy identity backfill. Authentication continues to read the
 * existing account login until an explicit claim-reader cutover; this service
 * never silently chooses a winner for a normalized-key collision.
 */
export class IdentityService {
  constructor(private readonly database: DatabaseContext) {}

  async backfillLegacyIdentities(): Promise<void> {
    const legacyAccounts = await this.database.db.select({ id: accounts.id, login: accounts.login }).from(accounts)
    for (const account of legacyAccounts) await this.backfillAccount(account)
  }

  private async backfillAccount(account: { id: string, login: string }): Promise<void> {
    const normalized = normalizeLoginKey(account.login)
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-identity:${normalized}`}))`)
      const [sameAccountIdentity] = await tx.select().from(accountIdentities).where(and(
        eq(accountIdentities.accountId, account.id), eq(accountIdentities.kind, 'username'), eq(accountIdentities.normalizedIdentifier, normalized), isNull(accountIdentities.disabledAt),
      )).limit(1)
      const [identityWithKey] = sameAccountIdentity === undefined ? await tx.select().from(accountIdentities).where(and(
        eq(accountIdentities.kind, 'username'), eq(accountIdentities.normalizedIdentifier, normalized), isNull(accountIdentities.disabledAt),
      )).limit(1) : [sameAccountIdentity]
      if (identityWithKey !== undefined && identityWithKey.accountId !== account.id) {
        await tx.insert(accountLoginClaimConflicts).values({ normalizedLoginKey: normalized, candidateAccountId: account.id, candidateIdentityId: null, candidateKind: 'legacy_username' }).onConflictDoNothing()
        return
      }
      const [identity] = sameAccountIdentity !== undefined ? [sameAccountIdentity]
        : identityWithKey === undefined
        ? await tx.insert(accountIdentities).values({ accountId: account.id, kind: 'username', identifier: account.login, normalizedIdentifier: normalized, isPrimary: true }).returning()
        : [identityWithKey]
      if (identity === undefined) throw new Error('Identity insert returned no row')
      const [claim] = await tx.select().from(accountLoginClaims).where(eq(accountLoginClaims.normalizedLoginKey, normalized)).limit(1)
      if (claim !== undefined && claim.accountId !== account.id) {
        await tx.insert(accountLoginClaimConflicts).values({ normalizedLoginKey: normalized, candidateAccountId: account.id, candidateIdentityId: identity.id, candidateKind: 'legacy_username' }).onConflictDoNothing()
        return
      }
      if (claim === undefined) await tx.insert(accountLoginClaims).values({ normalizedLoginKey: normalized, accountId: account.id, identityId: identity.id, kind: 'legacy_username' })
    })
  }

}

export function normalizeLoginKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('und')
}
