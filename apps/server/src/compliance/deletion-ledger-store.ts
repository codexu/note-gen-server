import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface DeletionLedgerReceipt {
  deletionCaseId: string
  subjectHash: string
  completedAt: string
  minimumBackupGeneration: string
  minimumDatabaseLsn: string | null
  receiptHash: string
}

export interface DeletionLedgerStore {
  initialize(): Promise<void>
  deliver(receipt: DeletionLedgerReceipt, idempotencyKey: string): Promise<{ externalRef: string }>
  listReceipts(): Promise<DeletionLedgerReceipt[]>
}

/** Internal-test durable sink. A separate immutable object store adapter must
 * replace this before live use; individual create-exclusive files make retry
 * delivery idempotent even if the process dies after the external write. */
export class FilesystemDeletionLedgerStore implements DeletionLedgerStore {
  constructor(private readonly rootPath: string) {}

  async initialize(): Promise<void> { await mkdir(this.rootPath, { recursive: true, mode: 0o700 }) }

  async deliver(receipt: DeletionLedgerReceipt, idempotencyKey: string): Promise<{ externalRef: string }> {
    const record = JSON.stringify({ version: 1, idempotencyKey, ...receipt })
    const fileName = `${createHash('sha256').update(idempotencyKey).digest('hex')}.json`
    const target = join(this.rootPath, fileName)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    try {
      const handle = await open(target, 'wx', 0o600)
      try { await handle.writeFile(record, 'utf8'); await handle.sync() } finally { await handle.close() }
    } catch (error: unknown) {
      if (!(isNodeError(error) && error.code === 'EEXIST')) throw error
      const existing = await readFile(target, 'utf8')
      if (existing !== record) throw new Error('Deletion ledger idempotency collision')
    }
    return { externalRef: `filesystem-ledger://${fileName}` }
  }

  async listReceipts(): Promise<DeletionLedgerReceipt[]> {
    await this.initialize()
    const names = await readdir(this.rootPath)
    const receipts: DeletionLedgerReceipt[] = []
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const value: unknown = JSON.parse(await readFile(join(this.rootPath, name), 'utf8'))
      if (!isStoredReceipt(value)) throw new Error(`Deletion ledger receipt ${name} is invalid`)
      const expectedName = `${createHash('sha256').update(value.idempotencyKey).digest('hex')}.json`
      if (name !== expectedName) throw new Error(`Deletion ledger receipt ${name} has an idempotency-key mismatch`)
      receipts.push(value)
    }
    return receipts
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && 'code' in error }

function isStoredReceipt(value: unknown): value is DeletionLedgerReceipt & { idempotencyKey: string } {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Record<string, unknown>
  return typeof receipt.deletionCaseId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.deletionCaseId)
    && typeof receipt.idempotencyKey === 'string' && receipt.idempotencyKey === `${receipt.deletionCaseId}:v1:deletion-ledger`
    && typeof receipt.subjectHash === 'string' && typeof receipt.completedAt === 'string' && Number.isFinite(new Date(receipt.completedAt).getTime())
    && typeof receipt.minimumBackupGeneration === 'string' && /^\d+$/.test(receipt.minimumBackupGeneration)
    && (receipt.minimumDatabaseLsn === null || typeof receipt.minimumDatabaseLsn === 'string')
    && typeof receipt.receiptHash === 'string'
    && receipt.receiptHash === createHash('sha256').update(`${receipt.subjectHash}:${receipt.deletionCaseId}:${receipt.completedAt}`).digest('base64url')
}
