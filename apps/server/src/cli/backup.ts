import { canonicalJson, verifyBackup } from '../backup/verification.js'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'
import { backupRuns } from '../database/schema.js'
import { desc } from 'drizzle-orm'
import { FilesystemBackupWriter } from '../backup/filesystem-writer.js'

function usage(): never {
  throw new Error('Usage: backup init-trust --directory <new-directory> --confirm INITIALIZE_BACKUP_TRUST | backup list | backup create --signing-key <private-pem> --signing-key-id <id> --allow-unencrypted-local I_UNDERSTAND_UNENCRYPTED_LOCAL_BACKUP --confirm CREATE_OFFLINE_FILESYSTEM_BACKUP | backup verify <manifest.json> --trust-store <file> --root-public-key <file> --minimum-trust-revision <decimal> --expected-trust-digest <sha256>')
}

async function main(): Promise<void> {
  const [command, manifestPath, ...rest] = process.argv.slice(2)
  if (command === 'init-trust') {
    const options = flags([...(manifestPath === undefined ? [] : [manifestPath]), ...rest])
    if (options.get('confirm') !== 'INITIALIZE_BACKUP_TRUST') usage()
    const directory = resolve(required(options, 'directory'))
    // Never replace an existing trust root or signing key by accident.
    await mkdir(directory, { recursive: false, mode: 0o700 })
    const root = generateKeyPairSync('ed25519')
    const writer = generateKeyPairSync('ed25519')
    const publicKeyPem = writer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const trust = { formatVersion: 1, revision: '1', keys: [{ keyId: 'backup-1', publicKeyPem, status: 'active' }] }
    const payload = canonicalJson(trust)
    const signature = { algorithm: 'ed25519', keyId: 'root-1', signature: sign(null, Buffer.from(payload), root.privateKey).toString('base64url') }
    for (const [name, value] of [
      ['root-private.pem', root.privateKey.export({ type: 'pkcs8', format: 'pem' })],
      ['root-public.pem', root.publicKey.export({ type: 'spki', format: 'pem' })],
      ['signing-private.pem', writer.privateKey.export({ type: 'pkcs8', format: 'pem' })],
      ['trust.json', `${canonicalJson({ ...trust, signature })}\n`],
    ] as const) await writeFile(resolve(directory, name), value, { mode: 0o600, flag: 'wx' })
    const trustDigest = createHash('sha256').update(payload).digest('hex')
    await writeFile(resolve(directory, 'trust-digest.txt'), `${trustDigest}\n`, { mode: 0o600, flag: 'wx' })
    process.stdout.write(`${JSON.stringify({ directory, signingKeyId: 'backup-1', minimumTrustRevision: '1', expectedTrustDigest: trustDigest, nextStep: 'Move root-private.pem offline; retain public root and trust digest separately from backups' })}\n`)
    return
  }
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
