import { randomUUID } from 'node:crypto'
import { basename, dirname, resolve, sep } from 'node:path'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import argon2 from 'argon2'
import { and, desc, eq, sql } from 'drizzle-orm'
import { loadConfig } from '../config.js'
import { verifyBackup } from '../backup/verification.js'
import { createDatabase } from '../database/client.js'
import { accounts, accountActionTokens, bootstrapCredentials, deploymentSettings, deviceAuthorizations, devicePairings, maintenanceState, refreshTokens, registrationInvitations, restoreCredentialReviews, restoreDrills, restoreMarkers, riskRestrictions, serverMetadata, webSessions } from '../database/schema.js'
import { RestoreFenceService } from '../restore-fence/service.js'
import { BackupInventoryService } from '../backup/inventory-service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const execFile = promisify(execFileCallback)

function usage(): never {
  throw new Error('Usage: restore preflight ... | restore register-verified ... | restore drill-verify ... | restore sanitize ... | restore credential-review ... | restore enforce-auth-epoch --offline-confirm ENFORCE_AUTH_EPOCH')
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command !== 'preflight' && command !== 'sanitize' && command !== 'register-verified' && command !== 'drill-verify' && command !== 'credential-review' && command !== 'enforce-auth-epoch') usage()
  const passwordStdin = rest.includes('--password-stdin')
  const flags = parseFlags(rest.filter(value => value !== '--password-stdin'))
  if (passwordStdin && command !== 'credential-review') usage()
  const config = loadConfig()
  if (config.deploymentMode !== 'self-hosted') throw new Error('Restore operations only support self-hosted deployments')
  if (command === 'credential-review') {
    const accountId = required(flags, 'account-id')
    const decision = required(flags, 'decision')
    if (!UUID.test(accountId) || (decision !== 'accept-restored-credentials' && decision !== 'reset-password' && decision !== 'disable-account')
      || required(flags, 'offline-confirm') !== 'ACCEPT_RESTORED_CREDENTIALS'
      || (passwordStdin && decision !== 'reset-password')) usage()
    const newPassword = decision === 'reset-password' ? await passwordFromStdin(passwordStdin) : undefined
    const passwordHash = newPassword === undefined ? undefined : await argon2.hash(newPassword, { type: argon2.argon2id })
    const database = createDatabase({ ...config, databasePoolSize: 1 })
    try {
      const result = await reviewRestoredCredentials(database, accountId, decision, passwordHash)
      process.stdout.write(`${JSON.stringify({ status: result.alreadyReviewed ? 'already-reviewed' : 'reviewed', accountId, markerId: result.markerId, maintenance: 'offline' })}\n`)
      return
    } finally { await database.close() }
  }
  if (command === 'enforce-auth-epoch') {
    if (required(flags, 'offline-confirm') !== 'ENFORCE_AUTH_EPOCH') usage()
    const database = createDatabase({ ...config, databasePoolSize: 1 })
    try {
      const epoch = await enforceInstanceAuthEpoch(database)
      process.stdout.write(`${JSON.stringify({ status: 'enforced', instanceAuthEpoch: epoch, maintenance: 'offline' })}\n`)
      return
    } finally { await database.close() }
  }
  const backupId = required(flags, 'backup-id')
  const mode = command === 'sanitize' || command === 'preflight' ? required(flags, 'mode') : undefined
  if (!UUID.test(backupId)) usage()
  if ((command === 'sanitize' || command === 'preflight') && (mode !== 'preserve' && mode !== 'clone')) usage()
  if (command === 'sanitize' && required(flags, 'offline-confirm') !== 'RESTORE_OFFLINE') usage()
  if (command === 'register-verified' && required(flags, 'offline-confirm') !== 'REGISTER_VERIFIED_BACKUP') usage()
  if (command === 'drill-verify' && required(flags, 'confirm') !== 'RECORD_VERIFY_DRILL') usage()
  // Restore is a destructive/offline operator operation. Do not allow a caller
  // to claim an arbitrary backup ID without first proving the local package,
  // its trust store and every artifact have been independently verified.
  const verified = await verifyBackup({
    manifestPath: required(flags, 'manifest'),
    trustStorePath: required(flags, 'trust-store'),
    rootPublicKeyPath: required(flags, 'root-public-key'),
    minimumTrustRevision: required(flags, 'minimum-trust-revision'),
    expectedTrustDigest: required(flags, 'expected-trust-digest'),
  })
  if (verified.backupId !== backupId) throw new Error('Verified manifest backup ID does not match --backup-id')
  if (command === 'preflight') {
    const result = await restorePreflight(
      config,
      verified,
      required(flags, 'manifest'),
      mode as 'clone' | 'preserve',
    )
    process.stdout.write(`${JSON.stringify({ status: 'passed', backupId, mode, ...result })}\n`)
    return
  }
  const database = createDatabase({ ...config, databasePoolSize: 1 })
  try {
    const inventory = new BackupInventoryService(database)
    const manifestRef = basename(required(flags, 'manifest'))
    if (command === 'register-verified') {
      await inventory.importVerifiedManifest(backupId, manifestRef, verified.artifactInventory, verified.backupGeneration)
      process.stdout.write(`${JSON.stringify({ status: 'registered', backupId, backupGeneration: verified.backupGeneration, manifest: manifestRef, verifiedArtifacts: verified.artifacts, trustRevision: verified.trustRevision })}\n`)
      return
    }
    if (command === 'drill-verify') {
      await inventory.assertManifestMatches(backupId, manifestRef, verified.artifactInventory)
      await inventory.assertManifestGeneration(backupId, verified.backupGeneration)
      const completedAt = new Date()
      const [drill] = await database.db.insert(restoreDrills).values({
        backupRunId: backupId, mode: 'verify-only', status: 'passed', startedAt: completedAt, completedAt,
        checks: { manifestSignature: 'passed', artifactInventory: 'passed', generationBinding: 'passed', trustRevision: verified.trustRevision, artifacts: verified.artifacts, totalBytes: verified.totalBytes },
      }).returning({ id: restoreDrills.id })
      if (drill === undefined) throw new Error('Restore verify drill insert failed')
      process.stdout.write(`${JSON.stringify({ status: 'passed', drillId: drill.id, mode: 'verify-only', backupId, backupGeneration: verified.backupGeneration, artifacts: verified.artifacts, trustRevision: verified.trustRevision })}\n`)
      return
    }
    if (mode !== 'preserve' && mode !== 'clone') usage()
    await inventory.assertManifestMatches(backupId, manifestRef, verified.artifactInventory)
    await inventory.assertManifestGeneration(backupId, verified.backupGeneration)
    // Do not use getOrCreateInstanceId here: a restore CLI must not mutate a
    // target just to inspect it, especially before proving offline fencing.
    let targetInstanceId = ''
    let resultingInstanceId = ''
    const marker = await database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-offline-restore'))`)
      const [maintenance] = await tx.select({ mode: maintenanceState.mode }).from(maintenanceState)
        .where(eq(maintenanceState.id, true)).limit(1).for('update')
      if (maintenance?.mode !== 'offline') throw new Error('Restore sanitation requires maintenance mode offline')
      const [currentInstance] = await tx.select({ value: serverMetadata.value }).from(serverMetadata)
        .where(eq(serverMetadata.key, 'instance_id')).limit(1).for('update')
      if (currentInstance === undefined || !UUID.test(currentInstance.value)) {
        throw new Error('Restored database has no valid instance ID')
      }
      targetInstanceId = currentInstance.value
      if (mode === 'preserve' && targetInstanceId !== verified.instanceId) {
        throw new Error('Preserve restore manifest instance ID does not match the target database')
      }
      resultingInstanceId = targetInstanceId
      const [currentEpoch] = await tx.select({ value: serverMetadata.value }).from(serverMetadata)
        .where(eq(serverMetadata.key, 'sync_epoch')).limit(1).for('update')
      if (currentEpoch === undefined || !UUID.test(currentEpoch.value)) throw new Error('Restored database has no valid sync epoch')
      const [settings] = await tx.select({ instanceAuthEpoch: deploymentSettings.instanceAuthEpoch }).from(deploymentSettings)
        .where(eq(deploymentSettings.id, true)).limit(1).for('update')
      if (settings === undefined) throw new Error('Restored database has no deployment settings')
      const [latest] = await tx.select({ authEpochAfter: restoreMarkers.authEpochAfter }).from(restoreMarkers)
        .orderBy(desc(restoreMarkers.createdAt)).limit(1).for('update')
      const nextAuthEpoch = [settings.instanceAuthEpoch, latest?.authEpochAfter ?? 0n]
        .reduce((max, value) => value > max ? value : max, 0n) + 1n
      const restoreStartedAt = new Date()
      await tx.update(deploymentSettings).set({
        instanceAuthEpoch: nextAuthEpoch, tokenNotBefore: restoreStartedAt, authEpochEnforced: true,
        updatedAt: restoreStartedAt,
      }).where(eq(deploymentSettings.id, true))
      const newSyncEpoch = randomUUID()
      if (mode === 'clone') {
        resultingInstanceId = randomUUID()
        await tx.update(serverMetadata).set({ value: resultingInstanceId }).where(eq(serverMetadata.key, 'instance_id'))
      }
      await tx.update(serverMetadata).set({ value: newSyncEpoch }).where(eq(serverMetadata.key, 'sync_epoch'))
      const [created] = await tx.insert(restoreMarkers).values({
        backupId, mode, oldSyncEpoch: currentEpoch.value, newSyncEpoch,
        sanitationStatus: 'pending', authEpochAfter: nextAuthEpoch,
        bootstrapTokenCutoff: restoreStartedAt, bootstrapReissueRequired: true,
      }).returning({ id: restoreMarkers.id, newSyncEpoch: restoreMarkers.newSyncEpoch, authEpochAfter: restoreMarkers.authEpochAfter })
      if (created === undefined) throw new Error('Restore marker insert failed')
      return created
    })
    await new RestoreFenceService(database).reconcile()
    if (marker.authEpochAfter === null) throw new Error('Restore marker is missing the authentication epoch')
    process.stdout.write(`${JSON.stringify({ status: 'sanitized', markerId: marker.id, syncEpoch: marker.newSyncEpoch, authEpochAfter: marker.authEpochAfter.toString(), maintenance: 'offline', verifiedArtifacts: verified.artifacts, trustRevision: verified.trustRevision, sourceInstanceId: verified.instanceId, targetInstanceId: resultingInstanceId })}\n`)
  } finally {
    await database.close()
  }
}

/** Performs only reversible/read-only checks. It intentionally does not use
 * BackupInventoryService: a target database may be empty before pg_restore,
 * and durable inventory registration occurs after separately verified bytes
 * have been imported into that target. */
async function restorePreflight(
  config: ReturnType<typeof loadConfig>,
  verified: Awaited<ReturnType<typeof verifyBackup>>,
  manifestPath: string,
  mode: 'preserve' | 'clone' | undefined,
): Promise<{ artifacts: number, totalBytes: string, pgRestore: string, targetDatabase: string, maintenance: 'offline' }> {
  if (mode !== 'preserve' && mode !== 'clone') usage()
  const databaseArtifacts = verified.artifactInventory.filter(artifact => artifact.path === 'database.dump')
  if (databaseArtifacts.length !== 1) throw new Error('Verified unified backup must contain exactly one database.dump artifact')
  const backupRoot = resolve(dirname(manifestPath))
  const databaseDump = resolve(backupRoot, databaseArtifacts[0]!.path)
  if (!databaseDump.startsWith(`${backupRoot}${sep}`)) throw new Error('Database dump escapes backup directory')
  await access(databaseDump)
  // `--file /dev/null` prevents a potentially large table-of-contents from
  // entering process memory while still making pg_restore parse the archive.
  const pgRestore = await execFile('pg_restore', ['--list', '--file', '/dev/null', databaseDump], { maxBuffer: 1024 * 1024 })
  const database = createDatabase({ ...config, databasePoolSize: 1 })
  try {
    const [maintenance] = await database.db.select({ mode: maintenanceState.mode }).from(maintenanceState).where(eq(maintenanceState.id, true)).limit(1)
    if (maintenance?.mode !== 'offline') throw new Error('Restore preflight requires maintenance mode offline')
    const [version] = await database.sql<Array<{ version: string }>>`select version()`
    await database.check()
    return {
      artifacts: verified.artifacts, totalBytes: verified.totalBytes,
      pgRestore: (pgRestore.stderr || pgRestore.stdout || 'pg_restore --list succeeded').trim().slice(0, 500),
      targetDatabase: version?.version ?? 'unknown', maintenance: 'offline',
    }
  } finally { await database.close() }
}

async function reviewRestoredCredentials(database: ReturnType<typeof createDatabase>, accountId: string, decision: 'accept-restored-credentials' | 'reset-password' | 'disable-account', passwordHash?: string): Promise<{ markerId: string, alreadyReviewed: boolean }> {
  return await database.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-offline-restore'))`)
    const [maintenance] = await tx.select({ mode: maintenanceState.mode }).from(maintenanceState)
      .where(eq(maintenanceState.id, true)).limit(1).for('update')
    if (maintenance?.mode !== 'offline') throw new Error('Credential review requires maintenance mode offline')
    const [marker] = await tx.select({ id: restoreMarkers.id }).from(restoreMarkers)
      .where(eq(restoreMarkers.sanitationStatus, 'complete')).orderBy(desc(restoreMarkers.createdAt)).limit(1).for('update')
    if (marker === undefined) throw new Error('Credential review requires a completed restore marker')
    const [prior] = await tx.select({ id: restoreCredentialReviews.id }).from(restoreCredentialReviews)
      .where(and(eq(restoreCredentialReviews.restoreMarkerId, marker.id), eq(restoreCredentialReviews.accountId, accountId))).limit(1)
    if (prior !== undefined) return { markerId: marker.id, alreadyReviewed: true }
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1).for('update')
    if (account === undefined) throw new Error('Account was not found')
    const [restriction] = await tx.select({ id: riskRestrictions.id }).from(riskRestrictions).where(and(
      eq(riskRestrictions.subjectType, 'account'), eq(riskRestrictions.subjectRef, accountId),
      eq(riskRestrictions.scope, 'authentication'), eq(riskRestrictions.action, 'review'),
      eq(riskRestrictions.reasonCode, 'credential_review_required'), sql`${riskRestrictions.revokedAt} is null`,
    )).limit(1).for('update')
    if (restriction === undefined) throw new Error('Account does not have an active restored-credential review restriction')
    const now = new Date()
    await tx.update(riskRestrictions).set({ revokedAt: now }).where(eq(riskRestrictions.id, restriction.id))
    await tx.update(accounts).set({
      credentialEpoch: sql`${accounts.credentialEpoch} + 1`, updatedAt: now,
      ...(decision === 'reset-password' ? { passwordHash: passwordHash!, totpSecret: null, totpEnabledAt: null } : {}),
      ...(decision === 'disable-account' ? { disabledAt: now } : {}),
    }).where(eq(accounts.id, accountId))
    await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.accountId, accountId), sql`${refreshTokens.revokedAt} is null`))
    await tx.delete(webSessions).where(eq(webSessions.accountId, accountId))
    await tx.update(accountActionTokens).set({ revokedAt: now }).where(and(eq(accountActionTokens.accountId, accountId), sql`${accountActionTokens.consumedAt} is null and ${accountActionTokens.revokedAt} is null`))
    await tx.update(deviceAuthorizations).set({ status: 'denied' }).where(and(eq(deviceAuthorizations.accountId, accountId), sql`${deviceAuthorizations.consumedAt} is null`))
    await tx.delete(devicePairings).where(and(eq(devicePairings.accountId, accountId), sql`${devicePairings.consumedAt} is null`))
    await tx.insert(restoreCredentialReviews).values({ restoreMarkerId: marker.id, accountId, decision })
    return { markerId: marker.id, alreadyReviewed: false }
  })
}

/** One-way compatibility cutover: every credential minted before this
 * transaction is invalidated before new epoch checks become mandatory. */
async function enforceInstanceAuthEpoch(database: ReturnType<typeof createDatabase>): Promise<string> {
  return await database.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-offline-restore'))`)
    const [maintenance] = await tx.select({ mode: maintenanceState.mode }).from(maintenanceState)
      .where(eq(maintenanceState.id, true)).limit(1).for('update')
    if (maintenance?.mode !== 'offline') throw new Error('Auth epoch enforcement requires maintenance mode offline')
    const [settings] = await tx.select({ epoch: deploymentSettings.instanceAuthEpoch }).from(deploymentSettings)
      .where(eq(deploymentSettings.id, true)).limit(1).for('update')
    if (settings === undefined) throw new Error('Deployment settings are missing')
    const now = new Date()
    const epoch = settings.epoch + 1n
    await tx.update(deploymentSettings).set({ instanceAuthEpoch: epoch, tokenNotBefore: now, authEpochEnforced: true, updatedAt: now })
      .where(eq(deploymentSettings.id, true))
    await tx.update(refreshTokens).set({ revokedAt: now }).where(sql`${refreshTokens.revokedAt} is null`)
    await tx.delete(webSessions)
    await tx.update(accountActionTokens).set({ revokedAt: now }).where(sql`${accountActionTokens.consumedAt} is null and ${accountActionTokens.revokedAt} is null`)
    await tx.update(bootstrapCredentials).set({ revokedAt: now }).where(sql`${bootstrapCredentials.consumedAt} is null and ${bootstrapCredentials.revokedAt} is null`)
    await tx.update(registrationInvitations).set({ revokedAt: now }).where(sql`${registrationInvitations.revokedAt} is null and ${registrationInvitations.useCount} < ${registrationInvitations.maxUses}`)
    await tx.update(deviceAuthorizations).set({ status: 'denied' }).where(sql`${deviceAuthorizations.consumedAt} is null`)
    await tx.delete(devicePairings).where(sql`${devicePairings.consumedAt} is null`)
    return epoch.toString()
  })
}

async function passwordFromStdin(enabled: boolean): Promise<string> {
  if (!enabled) usage()
  let raw = ''
  for await (const chunk of process.stdin) raw += String(chunk)
  const password = raw.trimEnd()
  if (password.length < 8 || password.length > 1_024) throw new Error('Password from stdin must contain 8 to 1024 characters')
  return password
}


function parseFlags(values: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1]
    if (!key?.startsWith('--') || value === undefined || result.has(key.slice(2))) usage()
    result.set(key.slice(2), value)
  }
  return result
}
function required(values: Map<string, string>, key: string): string { return values.get(key) ?? usage() }

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
