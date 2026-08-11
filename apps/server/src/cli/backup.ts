import { verifyBackup } from '../backup/verification.js'
import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'
import { backupRuns } from '../database/schema.js'
import { desc } from 'drizzle-orm'
import { FilesystemBackupWriter } from '../backup/filesystem-writer.js'

function usage(): never {
  throw new Error('Usage: backup list | backup create --signing-key <private-pem> --signing-key-id <id> --allow-unencrypted-local I_UNDERSTAND_UNENCRYPTED_LOCAL_BACKUP --confirm CREATE_OFFLINE_FILESYSTEM_BACKUP | backup verify <manifest.json> --trust-store <file> --root-public-key <file> --minimum-trust-revision <decimal> --expected-trust-digest <sha256>')
}

async function main(): Promise<void> {
  const [command, manifestPath, ...rest] = process.argv.slice(2)
  if (command === 'create') {
    const options = flags([...(manifestPath === undefined ? [] : [manifestPath]), ...rest])
    if (options.get('confirm') !== 'CREATE_OFFLINE_FILESYSTEM_BACKUP' || options.get('allow-unencrypted-local') !== 'I_UNDERSTAND_UNENCRYPTED_LOCAL_BACKUP') usage()
    const config = loadConfig()
    const database = createDatabase({ ...config, databasePoolSize: 1 })
    try {
      process.stderr.write('WARNING: this filesystem backup is unencrypted; use only an operator-controlled local target.\n')
      const result = await new FilesystemBackupWriter(config, database).create({
        signingKeyPath: required(options, 'signing-key'), signingKeyId: required(options, 'signing-key-id'),
      })
      process.stdout.write(`${JSON.stringify({ status: 'ready', ...result })}\n`)
      return
    } finally { await database.close() }
  }
  if (command === 'list' && manifestPath === undefined && rest.length === 0) {
    const config = loadConfig()
    if (config.deploymentMode !== 'self-hosted') throw new Error('Backup inventory is only available for self-hosted deployments')
    const database = createDatabase({ ...config, databasePoolSize: 1 })
    try {
      const runs = await database.db.select({
        id: backupRuns.id, generation: backupRuns.generation, status: backupRuns.status, manifestRef: backupRuns.manifestRef,
        databaseBytes: backupRuns.databaseBytes, blobCount: backupRuns.blobCount, blobBytes: backupRuns.blobBytes,
        errorCode: backupRuns.errorCode, createdAt: backupRuns.createdAt, completedAt: backupRuns.completedAt,
      }).from(backupRuns).orderBy(desc(backupRuns.createdAt)).limit(100)
      process.stdout.write(`${JSON.stringify({
        runs: runs.map(run => ({
          ...run,
          generation: run.generation.toString(),
          databaseBytes: run.databaseBytes?.toString() ?? null,
          blobCount: run.blobCount?.toString() ?? null,
          blobBytes: run.blobBytes?.toString() ?? null,
        })),
      })}\n`)
      return
    } finally {
      await database.close()
    }
  }
  if (command !== 'verify' || manifestPath === undefined) usage()
  const options = flags(rest)
  const result = await verifyBackup({
    manifestPath,
    trustStorePath: required(options, 'trust-store'),
    rootPublicKeyPath: required(options, 'root-public-key'),
    minimumTrustRevision: required(options, 'minimum-trust-revision'),
    expectedTrustDigest: required(options, 'expected-trust-digest'),
  })
  const { artifactInventory: _artifactInventory, ...report } = result
  process.stdout.write(`${JSON.stringify({ status: 'verified', ...report })}\n`)
}

function flags(values: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--') || result.has(key.slice(2))) usage()
    result.set(key.slice(2), value)
  }
  return result
}

function required(values: Map<string, string>, key: string): string { return values.get(key) ?? usage() }

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
