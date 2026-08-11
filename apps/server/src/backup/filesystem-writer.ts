import { createHash, sign as signDetached } from 'node:crypto'
import { constants } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { access, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { eq } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { deploymentSettings, maintenanceState, serverMetadata } from '../database/schema.js'
import { ApiError } from '../errors.js'
import { FilesystemBlobStorage } from '../storage/filesystem-blob-storage.js'
import { BackupInventoryService } from './inventory-service.js'
import { canonicalJson } from './verification.js'

const execFile = promisify(execFileCallback)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface FilesystemBackupWriterOptions {
  signingKeyPath: string
  signingKeyId: string
}

export interface FilesystemBackupResult {
  backupId: string
  backupGeneration: string
  manifestPath: string
  databaseBytes: string
  blobCount: string
  blobBytes: string
}

/**
 * Deliberately small unified writer for an offline, filesystem-only
 * self-hosted instance. Online/S3/encrypted target variants must use their
 * own snapshot/envelope implementations rather than weakening this contract.
 */
export class FilesystemBackupWriter {
  constructor(private readonly config: AppConfig, private readonly database: DatabaseContext) {}

  async create(options: FilesystemBackupWriterOptions): Promise<FilesystemBackupResult> {
    if (this.config.deploymentMode !== 'self-hosted' || this.config.blobStorageDriver !== 'filesystem') {
      throw new ApiError({ code: 'filesystem_backup_unsupported', message: 'Filesystem backup writer requires a self-hosted filesystem Blob deployment', statusCode: 409 })
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(options.signingKeyId)) {
      throw new ApiError({ code: 'backup_signing_key_id_invalid', message: 'Backup signing key ID is invalid', statusCode: 400 })
    }
    const signingKey = await readPrivateKey(options.signingKeyPath)
    const maintenanceGeneration = await this.assertOfflineAndPaths()

    const inventory = new BackupInventoryService(this.database)
    const run = await inventory.begin({ writer: 'filesystem-offline-v1' })
    const targetRoot = resolve(this.config.backupPath)
    const stagingRoot = resolve(targetRoot, `.incomplete-${run.id}`)
    const finalRoot = resolve(targetRoot, run.id)
    try {
      await mkdir(stagingRoot, { recursive: false, mode: 0o700 })
      await inventory.advance(run.id, 'preparing', 'draining', { writer: 'filesystem-offline-v1', maintenance: 'offline' })
      await inventory.advance(run.id, 'draining', 'dumping', { database: 'pg-custom' })
      const databasePath = resolve(stagingRoot, 'database.dump')
      await execFile('pg_dump', ['--format=custom', '--file', databasePath, this.config.databaseUrl], { maxBuffer: 1024 * 1024 })
      const databaseArtifact = await artifact(databasePath, 'database.dump')
      await inventory.recordArtifact(run.id, { kind: 'database', relativePath: databaseArtifact.path, sha256: databaseArtifact.sha256, size: databaseArtifact.size })

      await inventory.advance(run.id, 'dumping', 'copying', { blobs: 'filesystem-copy' })
      const storage = new FilesystemBlobStorage(this.config.blobStoragePath)
      let blobCount = 0n
      let blobBytes = 0n
      for await (const key of storage.listKeys()) {
        const destination = resolve(stagingRoot, 'blobs', key)
        assertWithin(stagingRoot, destination)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await pipeline(await storage.openReadStream(key), await createExclusiveWriteStream(destination))
        const copied = await artifact(destination, `blobs/${key}`)
        await inventory.recordArtifact(run.id, { kind: 'blob', relativePath: copied.path, sha256: copied.sha256, size: copied.size, sourceRef: key })
        blobCount += 1n
        blobBytes += copied.size
      }

      await inventory.advance(run.id, 'copying', 'verifying', { artifacts: 'sha256' })
      // A transition out of offline while copying means this package may span
      // writes. Do not publish it even if the operator turned offline on again.
      await this.assertMaintenanceGeneration(maintenanceGeneration)
      await inventory.summarize(run.id, { databaseBytes: databaseArtifact.size, blobCount, blobBytes })
      const identity = await this.identity()
      const artifacts = [databaseArtifact, ...await artifactsUnder(resolve(stagingRoot, 'blobs'), stagingRoot)]
      const now = new Date().toISOString()
      const manifest = {
        formatVersion: 2,
        backupId: run.id,
        createdAt: now,
        completedAt: now,
        serverVersion: '0.1.0',
        deploymentMode: 'self-hosted',
        instanceId: identity.instanceId,
        syncEpoch: identity.syncEpoch,
        authEpoch: identity.authEpoch,
        backupGeneration: run.generation,
        artifacts: artifacts.map(item => ({ path: item.path, sha256: item.sha256, size: item.size.toString() })),
      } as const
      await writeFile(resolve(stagingRoot, 'manifest.json'), `${canonicalJson(manifest)}\n`, { mode: 0o600, flag: 'wx' })
      const signature = signDetached(null, Buffer.from(canonicalJson(manifest)), signingKey).toString('base64url')
      await writeFile(resolve(stagingRoot, 'manifest.sig'), `${canonicalJson({ algorithm: 'ed25519', keyId: options.signingKeyId, signature })}\n`, { mode: 0o600, flag: 'wx' })
      await rename(stagingRoot, finalRoot)
      await inventory.markReady(run.id, 'manifest.json')
      return { backupId: run.id, backupGeneration: run.generation, manifestPath: resolve(finalRoot, 'manifest.json'), databaseBytes: databaseArtifact.size.toString(), blobCount: blobCount.toString(), blobBytes: blobBytes.toString() }
    } catch (error) {
      await inventory.fail(run.id, errorCode(error)).catch(() => undefined)
      throw error
    }
  }

  private async assertOfflineAndPaths(): Promise<string> {
    const [maintenance] = await this.database.db.select({ mode: maintenanceState.mode, generation: maintenanceState.generation }).from(maintenanceState).where(eq(maintenanceState.id, true)).limit(1)
    if (maintenance?.mode !== 'offline') throw new ApiError({ code: 'backup_requires_offline', message: 'Filesystem backup requires maintenance mode offline', statusCode: 409 })
    const target = resolve(this.config.backupPath)
    const blobRoot = resolve(this.config.blobStoragePath)
    if (target === blobRoot || target.startsWith(`${blobRoot}${sep}`) || blobRoot.startsWith(`${target}${sep}`)) {
      throw new ApiError({ code: 'backup_target_overlaps_blobs', message: 'Backup target must not overlap the Blob storage path', statusCode: 409 })
    }
    await mkdir(target, { recursive: true, mode: 0o700 })
    await access(target, constants.R_OK | constants.W_OK)
    return maintenance.generation.toString()
  }

  private async assertMaintenanceGeneration(expected: string): Promise<void> {
    const [maintenance] = await this.database.db.select({ mode: maintenanceState.mode, generation: maintenanceState.generation }).from(maintenanceState).where(eq(maintenanceState.id, true)).limit(1)
    if (maintenance?.mode !== 'offline' || maintenance.generation.toString() !== expected) {
      throw new ApiError({ code: 'backup_maintenance_changed', message: 'Maintenance mode changed during backup', statusCode: 409 })
    }
  }

  private async identity(): Promise<{ instanceId: string, syncEpoch: string, authEpoch: string }> {
    const [instance, epoch, settings] = await Promise.all([
      this.database.db.select({ value: serverMetadata.value }).from(serverMetadata).where(eq(serverMetadata.key, 'instance_id')).limit(1),
      this.database.db.select({ value: serverMetadata.value }).from(serverMetadata).where(eq(serverMetadata.key, 'sync_epoch')).limit(1),
      this.database.db.select({ authEpoch: deploymentSettings.instanceAuthEpoch }).from(deploymentSettings).limit(1),
    ])
    if (instance[0] === undefined || epoch[0] === undefined || settings[0] === undefined || !UUID.test(instance[0].value) || !UUID.test(epoch[0].value)) {
      throw new ApiError({ code: 'backup_instance_metadata_invalid', message: 'Backup requires initialized instance metadata', statusCode: 409 })
    }
    return { instanceId: instance[0].value, syncEpoch: epoch[0].value, authEpoch: settings[0].authEpoch.toString() }
  }
}

function createExclusiveWriteStream(path: string) {
  return createWriteStream(path, { flags: 'wx', mode: 0o600 })
}

async function readPrivateKey(path: string): Promise<string> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Backup signing key must be a regular non-symlink file')
  if ((details.mode & 0o077) !== 0) throw new Error('Backup signing key must not be group/world accessible')
  return readFile(path, 'utf8')
}

async function artifact(absolutePath: string, relativePath: string): Promise<{ path: string, sha256: string, size: bigint }> {
  const details = await stat(absolutePath)
  return { path: relativePath, sha256: createHash('sha256').update(await readFile(absolutePath)).digest('hex'), size: BigInt(details.size) }
}

async function artifactsUnder(root: string, base: string): Promise<Array<{ path: string, sha256: string, size: bigint }>> {
  try { await access(root) } catch { return [] }
  const { readdir } = await import('node:fs/promises')
  const result: Array<{ path: string, sha256: string, size: bigint }> = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name)
      assertWithin(base, target)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) result.push(await artifact(target, target.slice(base.length + 1)))
      else throw new Error('Backup Blob source contains a non-regular file')
    }
  }
  await visit(root)
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

function assertWithin(root: string, candidate: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) throw new Error('Backup path escapes staging root')
}
function errorCode(error: unknown): string { return error instanceof ApiError ? error.code : 'backup_writer_failed' }
