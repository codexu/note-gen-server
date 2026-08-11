import { createHash, verify as verifySignature } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

const MAX_MANIFEST_BYTES = 1_048_576
const MAX_SIGNATURE_BYTES = 16_384
const MAX_TRUST_STORE_BYTES = 1_048_576
const MAX_ROOT_KEY_BYTES = 65_536
const SHA256 = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface BackupArtifact {
  path: string
  sha256: string
  size: string
}

export interface BackupManifest {
  formatVersion: 1 | 2
  backupId: string
  createdAt: string
  completedAt: string
  serverVersion: string
  deploymentMode: 'self-hosted'
  instanceId: string
  syncEpoch: string
  authEpoch: string
  /** v2 binds an artifact package to the monotonic durable inventory run. */
  backupGeneration?: string
  artifacts: BackupArtifact[]
}

interface DetachedSignature { algorithm: 'ed25519', keyId: string, signature: string }
interface TrustKey { keyId: string, publicKeyPem: string, status: 'active' | 'retired' | 'revoked' }
interface BackupTrustStore { formatVersion: 1, revision: string, keys: TrustKey[], signature: DetachedSignature }

export interface VerifyBackupOptions {
  manifestPath: string
  trustStorePath: string
  rootPublicKeyPath: string
  minimumTrustRevision: string
  expectedTrustDigest: string
}

export interface VerifyBackupResult {
  backupId: string
  instanceId: string
  syncEpoch: string
  authEpoch: string
  backupGeneration: string | null
  artifactInventory: BackupArtifact[]
  artifacts: number
  totalBytes: string
  trustRevision: string
  trustDigest: string
}

/**
 * Verifies a complete, filesystem-local unified backup without writing to the
 * backup or to a database. The trust store and root key are deliberately
 * external inputs; a package cannot nominate its own signer.
 */
export async function verifyBackup(options: VerifyBackupOptions): Promise<VerifyBackupResult> {
  if (!decimal(options.minimumTrustRevision)) throw new Error('Required minimum trust revision is invalid')
  const trustText = await readLimitedText(options.trustStorePath, MAX_TRUST_STORE_BYTES, 'trust store')
  const trust = parseTrustStore(trustText)
  const trustDigest = sha256(canonicalJson(withoutSignature(trust)))
  if (BigInt(trust.revision) < BigInt(options.minimumTrustRevision)) {
    throw new Error(`Trust revision ${trust.revision} is below required minimum ${options.minimumTrustRevision}`)
  }
  if (trustDigest !== options.expectedTrustDigest) throw new Error('Trust store digest does not match the externally supplied expected digest')
  const rootPublicKey = await readLimitedText(options.rootPublicKeyPath, MAX_ROOT_KEY_BYTES, 'root public key')
  verifyDetached(canonicalJson(withoutSignature(trust)), trust.signature, rootPublicKey, 'trust store')

  const manifestText = await readLimitedText(options.manifestPath, MAX_MANIFEST_BYTES, 'manifest')
  const manifest = parseManifest(manifestText)
  const signaturePath = resolve(dirname(options.manifestPath), 'manifest.sig')
  const signature = parseDetachedSignature(await readLimitedText(signaturePath, MAX_SIGNATURE_BYTES, 'manifest signature'))
  const signingKey = trust.keys.find((candidate) => candidate.keyId === signature.keyId)
  if (signingKey === undefined || signingKey.status !== 'active') {
    throw new Error(`Manifest signing key ${signature.keyId} is not active in the external trust store`)
  }
  verifyDetached(canonicalJson(manifest), signature, signingKey.publicKeyPem, 'manifest')

  const root = resolve(dirname(options.manifestPath))
  let totalBytes = 0n
  for (const artifact of manifest.artifacts) {
    const artifactPath = resolveArtifact(root, artifact.path)
    const artifactStats = await lstat(artifactPath)
    if (!artifactStats.isFile() || artifactStats.isSymbolicLink()) throw new Error(`Artifact is not a regular non-symlink file: ${artifact.path}`)
    if (BigInt(artifactStats.size) !== BigInt(artifact.size)) throw new Error(`Artifact size mismatch: ${artifact.path}`)
    const digest = await hashFile(artifactPath)
    if (digest !== artifact.sha256) throw new Error(`Artifact SHA-256 mismatch: ${artifact.path}`)
    totalBytes += BigInt(artifact.size)
  }
  return {
    backupId: manifest.backupId, instanceId: manifest.instanceId, syncEpoch: manifest.syncEpoch, authEpoch: manifest.authEpoch,
    backupGeneration: manifest.backupGeneration ?? null,
    artifactInventory: manifest.artifacts, artifacts: manifest.artifacts.length, totalBytes: totalBytes.toString(), trustRevision: trust.revision, trustDigest,
  }
}

function parseManifest(text: string): BackupManifest {
  const value = parseJson(text, 'manifest')
  if (!isRecord(value)) throw new Error('Manifest has an invalid or unsupported format')
  const backupId = stringField(value, 'backupId')
  const createdAt = stringField(value, 'createdAt')
  const completedAt = stringField(value, 'completedAt')
  const serverVersion = stringField(value, 'serverVersion')
  const instanceId = stringField(value, 'instanceId')
  const syncEpoch = stringField(value, 'syncEpoch')
  const authEpoch = stringField(value, 'authEpoch')
  const formatVersion: 1 | 2 | undefined = value.formatVersion === 1 ? 1 : value.formatVersion === 2 ? 2 : undefined
  const backupGeneration = formatVersion === 2 ? stringField(value, 'backupGeneration') : undefined
  if (formatVersion === undefined || !UUID.test(backupId) || !isIsoDate(createdAt) || !isIsoDate(completedAt)
    || serverVersion.length === 0 || value.deploymentMode !== 'self-hosted' || !UUID.test(instanceId) || !UUID.test(syncEpoch)
    || !decimal(authEpoch) || (formatVersion === 2 && (backupGeneration === undefined || !decimal(backupGeneration)))
    || !Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw new Error('Manifest has an invalid or unsupported format')
  }
  const paths = new Set<string>()
  const artifacts = value.artifacts.map((item): BackupArtifact => {
    if (!isRecord(item)) throw new Error('Manifest contains an invalid artifact entry')
    const path = stringField(item, 'path')
    const sha256 = stringField(item, 'sha256')
    const size = stringField(item, 'size')
    if (!safeArtifactPath(path) || !SHA256.test(sha256) || !decimal(size)) {
      throw new Error('Manifest contains an invalid artifact entry')
    }
    if (paths.has(path)) throw new Error(`Manifest repeats artifact path: ${path}`)
    paths.add(path)
    return { path, sha256, size }
  })
  return { formatVersion, backupId, createdAt, completedAt, serverVersion, deploymentMode: 'self-hosted', instanceId, syncEpoch, authEpoch, ...(backupGeneration === undefined ? {} : { backupGeneration }), artifacts }
}

function parseTrustStore(text: string): BackupTrustStore {
  const value = parseJson(text, 'trust store')
  if (!isRecord(value)) throw new Error('Trust store has an invalid format')
  const revision = stringField(value, 'revision')
  if (value.formatVersion !== 1 || !decimal(revision) || !Array.isArray(value.keys)) {
    throw new Error('Trust store has an invalid format')
  }
  const keys = value.keys.map((item): TrustKey => {
    if (!isRecord(item)) throw new Error('Trust store contains an invalid key')
    const keyId = stringField(item, 'keyId')
    const publicKeyPem = stringField(item, 'publicKeyPem')
    const status = stringField(item, 'status')
    if (keyId.length === 0 || publicKeyPem.length === 0 || !['active', 'retired', 'revoked'].includes(status)) throw new Error('Trust store contains an invalid key')
    return { keyId, publicKeyPem, status: status as TrustKey['status'] }
  })
  if (new Set(keys.map(key => key.keyId)).size !== keys.length) throw new Error('Trust store repeats a key ID')
  return { formatVersion: 1, revision, keys, signature: parseDetachedSignature(value.signature) }
}

function parseDetachedSignature(value: unknown): DetachedSignature {
  if (!isRecord(value) || value.algorithm !== 'ed25519' || typeof value.keyId !== 'string' || value.keyId.length === 0
    || typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.signature)) throw new Error('Invalid detached signature')
  return { algorithm: 'ed25519', keyId: value.keyId, signature: value.signature }
}

function verifyDetached(payload: string, signature: DetachedSignature, publicKeyPem: string, subject: string): void {
  if (signature.algorithm !== 'ed25519' || !verifySignature(null, Buffer.from(payload), publicKeyPem, Buffer.from(signature.signature, 'base64url'))) {
    throw new Error(`${subject} signature verification failed`)
  }
}

function withoutSignature(store: BackupTrustStore): Omit<BackupTrustStore, 'signature'> {
  return { formatVersion: store.formatVersion, revision: store.revision, keys: store.keys }
}

/** Frozen canonical form shared by the writer and detached-signature reader. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!isRecord(value)) throw new Error('Canonical JSON only accepts plain JSON values')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function resolveArtifact(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error(`Artifact escapes backup directory: ${relativePath}`)
  return candidate
}

async function readLimitedText(path: string, maxBytes: number, subject: string): Promise<string> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${subject} must be a regular non-symlink file`)
  if (details.size > maxBytes) throw new Error(`${subject} exceeds ${maxBytes} byte limit`)
  return readFile(path, 'utf8')
}

async function hashFile(path: string): Promise<string> { return sha256(await readFile(path)) }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function parseJson(text: string, subject: string): unknown { try { return JSON.parse(text) } catch { throw new Error(`Invalid ${subject} JSON`) } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function stringField(value: Record<string, unknown>, field: string): string { return typeof value[field] === 'string' ? value[field] : '' }
function decimal(value: string): boolean { return /^(0|[1-9][0-9]*)$/.test(value) }
function isIsoDate(value: string): boolean { return value.length <= 40 && Number.isFinite(Date.parse(value)) }
function safeArtifactPath(path: string): boolean { return path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..') }
