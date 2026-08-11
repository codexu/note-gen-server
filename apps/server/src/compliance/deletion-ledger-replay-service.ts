import { createHmac } from 'node:crypto'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import type { DeletionLedgerStore } from './deletion-ledger-store.js'

/** Applies durable deletion receipts before Hosted accepts traffic after a DB
 * restore. It is intentionally safe to run on every boot: only an account
 * whose stable UUID HMAC appears in the external receipt set is affected. */
export class DeletionLedgerReplayService {
  constructor(private readonly database: DatabaseContext, private readonly config: AppConfig, private readonly store: DeletionLedgerStore) {}

  async reconcile(): Promise<number> {
    if (this.config.deploymentMode !== 'hosted') return 0
    const receipts = await this.store.listReceipts()
    if (receipts.length === 0) return 0
    const accounts = await this.database.sql<Array<{ id: string }>>`select id from accounts`
    const accountBySubject = new Map(accounts.map(account => [this.subjectHash(account.id), account.id]))
    let replayed = 0
    for (const receipt of receipts) {
      const accountId = accountBySubject.get(receipt.subjectHash)
      const changed = await this.database.sql.begin(async (tx) => {
        await tx`insert into deletion_ledger (subject_hash, hash_key_id, deletion_case_id, completed_at, minimum_backup_generation, minimum_database_lsn, receipt_hash)
          values (${receipt.subjectHash}, 'auth-secret-v1', ${receipt.deletionCaseId}, ${receipt.completedAt}::timestamptz, ${receipt.minimumBackupGeneration}::bigint, ${receipt.minimumDatabaseLsn}, ${receipt.receiptHash})
          on conflict (subject_hash) do nothing`
        const [localLedger] = await tx<Array<{ deletion_case_id: string, completed_at: string, minimum_backup_generation: string, minimum_database_lsn: string | null, receipt_hash: string }>>`
          select deletion_case_id, completed_at::text, minimum_backup_generation::text, minimum_database_lsn, receipt_hash
          from deletion_ledger where subject_hash = ${receipt.subjectHash} for update`
        if (localLedger === undefined || localLedger.deletion_case_id !== receipt.deletionCaseId
          || new Date(localLedger.completed_at).getTime() !== new Date(receipt.completedAt).getTime()
          || localLedger.minimum_backup_generation !== receipt.minimumBackupGeneration
          || localLedger.minimum_database_lsn !== receipt.minimumDatabaseLsn
          || localLedger.receipt_hash !== receipt.receiptHash) {
          throw new Error(`Deletion ledger receipt conflicts with local ledger for subject ${receipt.subjectHash}`)
        }
        if (accountId === undefined) {
          await tx`insert into account_deletion_cases (id, subject_hash, status, completed_at)
            values (${receipt.deletionCaseId}, ${receipt.subjectHash}, 'completed', ${receipt.completedAt}::timestamptz)
            on conflict (id) do nothing`
          await this.markDelivered(tx, receipt)
          return false
        }
        await tx`select pg_advisory_xact_lock(hashtext(${`notegen-deletion:${accountId}`}))`
        const [account] = await tx<Array<{ id: string }>>`select id from accounts where id = ${accountId} for update`
        if (account === undefined) return false
        await tx`insert into account_deletion_cases (id, account_id, subject_hash, status, requested_at, purge_after)
          values (${receipt.deletionCaseId}, ${accountId}, ${receipt.subjectHash}, 'scheduled', now(), now())
          on conflict (id) do update set account_id = excluded.account_id, status = 'scheduled', completed_at = null, purge_after = now()`
        await this.markDelivered(tx, receipt)
        await tx`insert into deletion_case_steps (deletion_case_id, handler, idempotency_key)
          values (${receipt.deletionCaseId}, 'workspace_blob', ${`${receipt.deletionCaseId}:v1:workspace_blob`}), (${receipt.deletionCaseId}, 'support_content', ${`${receipt.deletionCaseId}:v1:support_content`}), (${receipt.deletionCaseId}, 'identity', ${`${receipt.deletionCaseId}:v1:identity`})
          on conflict (deletion_case_id, handler) do nothing`
        await tx`insert into account_deletion_fences (account_uuid, subject_hash, state, blocks_domain_writes)
          values (${accountId}, ${receipt.subjectHash}, 'scheduled', true)
          on conflict (account_uuid) do update set subject_hash = excluded.subject_hash, state = 'scheduled', blocks_domain_writes = true, completed_at = null, updated_at = now()`
        await tx`update accounts set disabled_at = now(), credential_epoch = credential_epoch + 1, updated_at = now() where id = ${accountId}`
        await tx`update devices set revoked_at = now(), updated_at = now() where account_id = ${accountId} and revoked_at is null`
        await tx`update refresh_tokens set revoked_at = now() where account_id = ${accountId} and revoked_at is null`
        await tx`delete from web_sessions where account_id = ${accountId}`
        await tx`update account_action_tokens set revoked_at = now() where account_id = ${accountId} and consumed_at is null and revoked_at is null`
        await tx`update device_authorizations set status = 'denied' where account_id = ${accountId} and consumed_at is null`
        await tx`delete from device_pairings where account_id = ${accountId} and consumed_at is null`
        await tx`update workspaces set deleted_at = now(), updated_at = now() where account_id = ${accountId}`
        return true
      })
      if (changed) replayed += 1
    }
    return replayed
  }

  private subjectHash(accountId: string): string {
    return createHmac('sha256', this.config.authSecret).update(`compliance-subject:v1:${accountId}`).digest('base64url')
  }

  private async markDelivered(tx: any, receipt: { deletionCaseId: string, subjectHash: string }): Promise<void> {
    await tx`insert into deletion_ledger_outbox (deletion_case_id, subject_hash, idempotency_key, payload_hash, status, delivered_at, external_ref)
      values (${receipt.deletionCaseId}, ${receipt.subjectHash}, ${`${receipt.deletionCaseId}:v1:deletion-ledger`}, 'replayed-external-receipt', 'delivered', now(), 'filesystem-ledger://replayed')
      on conflict (deletion_case_id) do update set status = 'delivered', delivered_at = coalesce(deletion_ledger_outbox.delivered_at, excluded.delivered_at), external_ref = coalesce(deletion_ledger_outbox.external_ref, excluded.external_ref)`
  }
}
