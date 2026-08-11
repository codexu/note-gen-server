import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { backupArtifacts, backupRuns, maintenanceState } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { BackupArtifact } from './verification.js'

const SHA256 = /^[a-f0-9]{64}$/
const safePath = (value: string): boolean => value.length > 0 && value.length <= 1024 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')

/** Durable inventory state machine for the future unified backup writer. */
export class BackupInventoryService {
  constructor(private readonly database: DatabaseContext) {}

  async begin(checkpoint: Record<string, unknown> = {}): Promise<{ id: string, generation: string }> {
    const [created] = await this.database.db.insert(backupRuns).values({ status: 'preparing', checkpoint }).returning({ id: backupRuns.id, generation: backupRuns.generation })
    if (created === undefined) throw new Error('Backup run insert returned no row')
    return { id: created.id, generation: created.generation.toString() }
  }

  async advance(runId: string, from: 'preparing' | 'draining' | 'dumping' | 'copying', to: 'draining' | 'dumping' | 'copying' | 'verifying', checkpoint: Record<string, unknown> = {}): Promise<void> {
    const allowed = (from === 'preparing' && to === 'draining')
      || (from === 'draining' && to === 'dumping')
      || (from === 'dumping' && to === 'copying')
      || (from === 'copying' && to === 'verifying')
    if (!allowed) throw new ApiError({ code: 'backup_transition_invalid', message: 'Backup state transition is invalid', statusCode: 409 })
    const changed = await this.database.db.update(backupRuns).set({ status: to, checkpoint })
      .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, from))).returning({ id: backupRuns.id })
    if (changed.length !== 1) throw new ApiError({ code: 'backup_transition_raced', message: 'Backup state changed concurrently', statusCode: 409, retryable: true })
  }

  async recordArtifact(runId: string, artifact: { kind: string, relativePath: string, sha256: string, size: bigint, sourceRef?: string }): Promise<void> {
    if (!safePath(artifact.relativePath) || !SHA256.test(artifact.sha256) || artifact.size < 0n || artifact.kind.trim().length === 0) {
      throw new ApiError({ code: 'backup_artifact_invalid', message: 'Backup artifact inventory is invalid', statusCode: 400 })
    }
    await this.database.db.transaction(async tx => {
      const [run] = await tx.select({ status: backupRuns.status }).from(backupRuns).where(eq(backupRuns.id, runId)).limit(1).for('update')
      if (run === undefined || !['preparing', 'draining', 'dumping', 'copying', 'verifying'].includes(run.status)) throw new ApiError({ code: 'backup_run_not_writable', message: 'Backup run cannot accept artifacts in its current state', statusCode: 409 })
      await tx.insert(backupArtifacts).values({ backupRunId: runId, ...artifact }).onConflictDoUpdate({
        target: [backupArtifacts.backupRunId, backupArtifacts.relativePath],
        set: { kind: artifact.kind, sha256: artifact.sha256, size: artifact.size, sourceRef: artifact.sourceRef },
      })
    })
  }

  async markReady(runId: string, manifestRef: string): Promise<void> {
    if (!safePath(manifestRef)) throw new ApiError({ code: 'backup_manifest_invalid', message: 'Backup manifest path is invalid', statusCode: 400 })
    await this.database.db.transaction(async tx => {
      const [run] = await tx.select({ status: backupRuns.status }).from(backupRuns).where(eq(backupRuns.id, runId)).limit(1).for('update')
      if (run === undefined || !['copying', 'verifying'].includes(run.status)) throw new ApiError({ code: 'backup_run_not_ready', message: 'Backup run cannot be finalized in its current state', statusCode: 409 })
      const artifacts = await tx.select({ id: backupArtifacts.id }).from(backupArtifacts).where(eq(backupArtifacts.backupRunId, runId)).limit(1)
      if (artifacts.length === 0) throw new ApiError({ code: 'backup_artifacts_missing', message: 'Backup run has no verified artifacts', statusCode: 409 })
      const changed = await tx.update(backupRuns).set({ status: 'ready', manifestRef, completedAt: new Date() })
        .where(and(eq(backupRuns.id, runId), inArray(backupRuns.status, ['copying', 'verifying']))).returning({ id: backupRuns.id })
      if (changed.length !== 1) throw new ApiError({ code: 'backup_ready_raced', message: 'Backup state changed concurrently', statusCode: 409, retryable: true })
    })
  }

  async summarize(runId: string, summary: { databaseBytes: bigint, blobCount: bigint, blobBytes: bigint }): Promise<void> {
    const changed = await this.database.db.update(backupRuns).set(summary)
      .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, 'verifying'))).returning({ id: backupRuns.id })
    if (changed.length !== 1) throw new ApiError({ code: 'backup_summary_unavailable', message: 'Backup run cannot accept a summary in its current state', statusCode: 409 })
  }

  /** Idempotently terminalizes an interrupted writer without erasing its
   * inventory, so operators and a later cleanup worker can inspect it. */
  async fail(runId: string, errorCode: string): Promise<void> {
    if (!/^[a-z0-9_:-]{1,120}$/i.test(errorCode)) throw new ApiError({ code: 'backup_error_code_invalid', message: 'Backup error code is invalid', statusCode: 400 })
    await this.database.db.update(backupRuns).set({ status: 'failed', errorCode, completedAt: new Date() })
      .where(and(eq(backupRuns.id, runId), inArray(backupRuns.status, ['queued', 'preparing', 'draining', 'dumping', 'copying', 'verifying'])))
  }

  async cancel(runId: string): Promise<void> {
    const changed = await this.database.db.update(backupRuns).set({ status: 'deleting' })
      .where(and(eq(backupRuns.id, runId), inArray(backupRuns.status, ['queued', 'preparing', 'draining', 'dumping', 'copying', 'verifying', 'failed'])))
      .returning({ id: backupRuns.id })
    if (changed.length !== 1) throw new ApiError({ code: 'backup_cancel_unavailable', message: 'Backup run cannot be cancelled in its current state', statusCode: 409 })
  }

  /**
   * An offline restore applies database bytes before it can write a local
   * control-plane fact. This imports the independently verified manifest into
   * that restored target, so `restore sanitize` never relies on a stale
   * pre-snapshot backup_runs row. It is intentionally explicit and only
   * accepts an empty/preparing run or an identical ready run.
   */
  async importVerifiedManifest(runId: string, manifestRef: string, artifacts: readonly BackupArtifact[], generation: string | null): Promise<void> {
    if (!safePath(manifestRef) || artifacts.length === 0 || generation === null || !/^(0|[1-9][0-9]*)$/.test(generation)) {
      throw new ApiError({ code: 'backup_manifest_invalid', message: 'Verified backup manifest is invalid', statusCode: 400 })
    }
    const normalized = artifacts.map((artifact) => ({
      kind: artifact.path === 'database.dump' ? 'database' : 'blob', relativePath: artifact.path,
      sha256: artifact.sha256, size: BigInt(artifact.size),
    }))
    if (new Set(normalized.map(artifact => artifact.relativePath)).size !== normalized.length
      || normalized.some(artifact => !safePath(artifact.relativePath) || !SHA256.test(artifact.sha256) || artifact.size < 0n)) {
      throw new ApiError({ code: 'backup_artifact_invalid', message: 'Verified backup manifest inventory is invalid', statusCode: 400 })
    }
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-backup-import:${runId}`}))`)
      const [maintenance] = await tx.select({ mode: maintenanceState.mode }).from(maintenanceState)
        .where(eq(maintenanceState.id, true)).limit(1).for('update')
      if (maintenance?.mode !== 'offline') {
        throw new ApiError({ code: 'backup_import_requires_offline', message: 'Verified backup registration requires offline maintenance', statusCode: 409 })
      }
      const [run] = await tx.select({ status: backupRuns.status, manifestRef: backupRuns.manifestRef, generation: backupRuns.generation })
        .from(backupRuns).where(eq(backupRuns.id, runId)).limit(1).for('update')
      if (run?.status === 'ready') {
        if (run.manifestRef !== manifestRef || run.generation.toString() !== generation) throw new ApiError({ code: 'backup_inventory_mismatch', message: 'Ready backup run has a different manifest or generation', statusCode: 409 })
        const stored = await tx.select({ relativePath: backupArtifacts.relativePath, sha256: backupArtifacts.sha256, size: backupArtifacts.size })
          .from(backupArtifacts).where(eq(backupArtifacts.backupRunId, runId))
        assertSameInventory(stored, normalized)
        return
      }
      if (run !== undefined && run.generation.toString() !== generation) {
        throw new ApiError({ code: 'backup_import_unavailable', message: 'Backup run cannot accept an imported verified manifest', statusCode: 409 })
      }
      if (run === undefined) {
        await tx.insert(backupRuns).values({ id: runId, generation: BigInt(generation), status: 'preparing', checkpoint: { imported: true, sourceGeneration: generation } })
        // An explicit generation is needed to bind the imported inventory to
        // the signed package. Advance the serial sequence under the offline
        // restore lock so a subsequent locally-created run cannot collide.
        await tx.execute(sql`select setval(pg_get_serial_sequence('backup_runs', 'generation'), greatest((select coalesce(max(generation), 0) from backup_runs), nextval(pg_get_serial_sequence('backup_runs', 'generation'))))`)
      } else {
        // The DB snapshot can legitimately contain the source run in an
        // in-progress state (the writer's own final manifest is created after
        // the database dump). Offline registration replaces only that stale
        // state after generation binding has been proven above.
        await tx.update(backupRuns).set({ status: 'preparing', manifestRef: null, checkpoint: { imported: true, sourceGeneration: generation }, completedAt: null, errorCode: null })
          .where(eq(backupRuns.id, runId))
      }
      const existing = await tx.select({ id: backupArtifacts.id }).from(backupArtifacts).where(eq(backupArtifacts.backupRunId, runId)).limit(1)
      if (existing.length > 0) {
        const stored = await tx.select({ relativePath: backupArtifacts.relativePath, sha256: backupArtifacts.sha256, size: backupArtifacts.size })
          .from(backupArtifacts).where(eq(backupArtifacts.backupRunId, runId))
        assertSameInventory(stored, normalized)
      } else {
        await tx.insert(backupArtifacts).values(normalized.map(artifact => ({ backupRunId: runId, ...artifact })))
      }
      await tx.update(backupRuns).set({ status: 'ready', manifestRef, completedAt: new Date(), checkpoint: { imported: true } })
        .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, 'preparing')))
    })
  }

  /** Verifies that a signed manifest's artifacts exactly match durable run
   * inventory before a restore workflow is allowed to consume the package. */
  async assertManifestMatches(runId: string, manifestRef: string, artifacts: readonly BackupArtifact[]): Promise<void> {
    const [run] = await this.database.db.select({ status: backupRuns.status, manifestRef: backupRuns.manifestRef })
      .from(backupRuns).where(eq(backupRuns.id, runId)).limit(1)
    if (run === undefined || run.status !== 'ready' || run.manifestRef !== manifestRef) {
      throw new ApiError({ code: 'backup_run_unverified', message: 'Backup run is not ready for this manifest', statusCode: 409 })
    }
    const stored = await this.database.db.select({ relativePath: backupArtifacts.relativePath, sha256: backupArtifacts.sha256, size: backupArtifacts.size })
      .from(backupArtifacts).where(eq(backupArtifacts.backupRunId, runId))
    if (stored.length !== artifacts.length) throw new ApiError({ code: 'backup_inventory_mismatch', message: 'Backup manifest does not match durable inventory', statusCode: 409 })
    const byPath = new Map(stored.map(artifact => [artifact.relativePath, artifact]))
    for (const artifact of artifacts) {
      const expected = byPath.get(artifact.path)
      if (expected === undefined || expected.sha256 !== artifact.sha256 || expected.size.toString() !== artifact.size) {
        throw new ApiError({ code: 'backup_inventory_mismatch', message: 'Backup manifest does not match durable inventory', statusCode: 409 })
      }
    }
  }

  async assertManifestGeneration(runId: string, generation: string | null): Promise<void> {
    if (generation === null || !/^(0|[1-9][0-9]*)$/.test(generation)) {
      throw new ApiError({ code: 'backup_generation_missing', message: 'Restore requires a generation-bound v2 backup manifest', statusCode: 409 })
    }
    const [run] = await this.database.db.select({ generation: backupRuns.generation, status: backupRuns.status })
      .from(backupRuns).where(eq(backupRuns.id, runId)).limit(1)
    if (run === undefined || run.status !== 'ready' || run.generation.toString() !== generation) {
      throw new ApiError({ code: 'backup_generation_mismatch', message: 'Backup manifest generation does not match durable inventory', statusCode: 409 })
    }
  }

  static requestHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('base64url') }
}

function assertSameInventory(
  stored: readonly { relativePath: string, sha256: string, size: bigint }[],
  expected: readonly { relativePath: string, sha256: string, size: bigint }[],
): void {
  if (stored.length !== expected.length) throw new ApiError({ code: 'backup_inventory_mismatch', message: 'Backup manifest does not match durable inventory', statusCode: 409 })
  const byPath = new Map(stored.map(artifact => [artifact.relativePath, artifact]))
  for (const artifact of expected) {
    const found = byPath.get(artifact.relativePath)
    if (found === undefined || found.sha256 !== artifact.sha256 || found.size !== artifact.size) {
      throw new ApiError({ code: 'backup_inventory_mismatch', message: 'Backup manifest does not match durable inventory', statusCode: 409 })
    }
  }
}
