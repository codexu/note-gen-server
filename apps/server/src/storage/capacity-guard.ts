import { statfs } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { ApiError } from '../errors.js'

type StorageTransaction = Parameters<Parameters<DatabaseContext['db']['transaction']>[0]>[0]
export interface StorageBudget { accountBytes: bigint; instanceBytes: bigint }

/** Self-hosted resource protection, independent of subscriptions/entitlements.
 * Counts retained ciphertext and upload reservations as well as live data.
 * All writers acquire the same transaction lock before changing that budget.
 */
export class StorageCapacityGuard {
  constructor(private readonly config: AppConfig) {}

  async lock(tx: StorageTransaction): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-storage-budget'))`)
  }

  async readBudget(tx: StorageTransaction, ownerAccountId: string): Promise<StorageBudget> {
    // octet_length can read a TOAST value's length without materializing the
    // entire encrypted payload. Metadata allowances are deliberately counted.
    const tables = [
      ['objects', 'octet_length(t.ciphertext) + coalesce(octet_length(t.name_ciphertext), 0) + 256'],
      ['object_versions', 'octet_length(t.ciphertext) + coalesce(octet_length(t.name_ciphertext), 0) + 256'],
      ['sync_documents', 'coalesce(octet_length(t.checkpoint_ciphertext), 0) + 256'],
      ['sync_updates', 'octet_length(t.ciphertext) + 256'],
      ['sync_events', 'coalesce(octet_length(t.ciphertext), 0) + pg_column_size(t.metadata) + 256'],
      ['sync_commands', 'pg_column_size(t.result) + 256'],
      ['sync_checkpoints', 'octet_length(t.ciphertext) + 256'],
      ['sync_conflicts', 'octet_length(t.ciphertext) + 256'],
      ['sync_bootstrap_objects', 'coalesce(octet_length(t.checkpoint_ciphertext), 0) + 256'],
      ['sync_resource_bindings', '256'],
      ['workspace_keys', '256'],
      ['workspace_key_envelopes', 'octet_length(t.wrapped_key) + coalesce(octet_length(t.kdf_salt), 0) + coalesce(pg_column_size(t.kdf_params), 0) + 512'],
    ] as const
    const counters = tables.map(([table, bytes]) => sql`
      select w.account_id, coalesce(sum(${sql.raw(bytes)}), 0)::bigint as bytes
      from ${sql.raw(table)} t join workspaces w on w.id = t.workspace_id
      group by w.account_id`)
    counters.push(sql`
      select w.account_id, coalesce(sum(b.size + pg_column_size(b)), 0)::bigint as bytes
      from blobs b join workspaces w on w.id = b.workspace_id group by w.account_id`)
    counters.push(sql`
      select w.account_id, coalesce(sum(octet_length(w.name_ciphertext) + 512), 0)::bigint as bytes
      from workspaces w group by w.account_id`)
    const rows = await tx.execute<{ instance_bytes: string, account_bytes: string }>(sql`
      select coalesce(sum(bytes), 0)::text as instance_bytes,
        coalesce(sum(bytes) filter (where account_id = ${ownerAccountId}::uuid), 0)::text as account_bytes
      from (${sql.join(counters, sql` union all `)}) budget`)
    const row = rows[0]
    if (row === undefined) throw new Error('Storage budget query returned no row')
    return { accountBytes: BigInt(row.account_bytes), instanceBytes: BigInt(row.instance_bytes) }
  }

  /** Replacement operations can reduce existing use even after the operator
   * lowers a budget. They may not increase either already-exceeded total. */
  async assertBudget(tx: StorageTransaction, ownerAccountId: string, beforeReplacement?: StorageBudget): Promise<void> {
    const accountLimit = BigInt(this.config.accountStorageMaxBytes ?? 5 * 1024 ** 3)
    const instanceLimit = BigInt(this.config.instanceStorageMaxBytes ?? 50 * 1024 ** 3)
    const { accountBytes, instanceBytes } = await this.readBudget(tx, ownerAccountId)
    const allowedAccount = beforeReplacement && beforeReplacement.accountBytes > accountLimit ? beforeReplacement.accountBytes : accountLimit
    const allowedInstance = beforeReplacement && beforeReplacement.instanceBytes > instanceLimit ? beforeReplacement.instanceBytes : instanceLimit
    if (accountBytes > allowedAccount || instanceBytes > allowedInstance) {
      const accountExceeded = accountBytes > allowedAccount
      throw new ApiError({
        code: 'quota_exceeded', message: 'The self-hosted storage budget is exhausted', statusCode: 409,
        details: {
          scope: accountExceeded ? 'account' : 'instance', metric: 'storage_bytes',
          used: (accountExceeded ? accountBytes : instanceBytes).toString(),
          limit: (accountExceeded ? accountLimit : instanceLimit).toString(),
        },
      })
    }
  }

  async assertLocalSpace(additionalBytes = 0n): Promise<void> {
    if (this.config.blobStorageDriver !== 'filesystem') return
    const space = await statfs(this.config.blobStoragePath, { bigint: true })
    const free = space.bavail * space.bsize
    const minimum = BigInt(this.config.storageMinFreeBytes ?? 1024 ** 3)
    if (free < minimum + additionalBytes) {
      throw new ApiError({
        code: 'storage_space_low', message: 'Blob storage has insufficient free space', statusCode: 503,
        retryable: true,
        details: { availableBytes: free.toString(), minimumFreeBytes: minimum.toString() },
      })
    }
  }
}
