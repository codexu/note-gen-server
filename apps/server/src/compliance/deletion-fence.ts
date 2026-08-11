import { eq, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accountDeletionFences } from '../database/schema.js'
import { ApiError } from '../errors.js'

export type DeletionFenceTransaction = Parameters<Parameters<DatabaseContext['db']['transaction']>[0]>[0]

/**
 * Serializes an account-scoped domain mutation with deletion and legal-hold
 * transitions. Authentication alone is insufficient: a request may have
 * authenticated before deletion revoked its credentials, then reach its write
 * transaction afterwards.
 */
export async function assertAccountWriteAllowedInTransaction(tx: DeletionFenceTransaction, accountId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${accountId}`}))`)
  const [fence] = await tx.select({ blocksDomainWrites: accountDeletionFences.blocksDomainWrites })
    .from(accountDeletionFences).where(eq(accountDeletionFences.accountUuid, accountId)).limit(1)
  if (fence?.blocksDomainWrites) {
    throw new ApiError({ code: 'account_deletion_in_progress', message: 'Account deletion is in progress', statusCode: 409 })
  }
}
