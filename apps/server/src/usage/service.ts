import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accountUsage, usageEvents, usageReservations } from '../database/schema.js'
import { ApiError } from '../errors.js'

/**
 * Account counter primitives. Callers provide the resolved limit from the
 * policy layer; this service deliberately knows nothing about plan names.
 */
export class UsageService {
  constructor(private readonly database: DatabaseContext) {}

  /** Reads a durable snapshot. Reconciliation is opt-in because a GET must
   * not bypass read_only/write_drain/offline maintenance fences. */
  async getSnapshot(accountId: string, reconcile = false): Promise<{ revision: string, metrics: Record<string, string>, updatedAt: Date | null }> {
    const row = reconcile
      ? await this.reconcileCurrent(accountId)
      : (await this.database.db.select().from(accountUsage).where(eq(accountUsage.accountId, accountId)).limit(1))[0]
    const current = row ?? {
      revision: 0n, updatedAt: null, activeObjectBytes: 0n, activeCrdtBytes: 0n, activeBlobBytes: 0n,
      reservedBlobBytes: 0n, retainedBytes: 0n, activeObjects: 0n, activeDevices: 0n, activeWorkspaces: 0n,
    }
    const now = new Date()
    const billingPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const monthly = await this.database.sql<Array<{ metric: string, total: string }>>`
      select metric, coalesce(sum(delta), 0)::text as total
      from usage_events
      where account_id = ${accountId} and billing_period = ${billingPeriod}
        and metric in ('monthly_ingress_bytes', 'monthly_egress_bytes')
      group by metric`
    const monthlyMetrics = new Map(monthly.map(event => [event.metric, event.total]))
    return {
      revision: current.revision.toString(), updatedAt: current.updatedAt,
      metrics: {
        activeObjectBytes: current.activeObjectBytes.toString(), activeCrdtBytes: current.activeCrdtBytes.toString(),
        activeBlobBytes: current.activeBlobBytes.toString(), reservedBlobBytes: current.reservedBlobBytes.toString(), retainedBytes: current.retainedBytes.toString(),
        activeObjects: current.activeObjects.toString(), activeDevices: current.activeDevices.toString(), activeWorkspaces: current.activeWorkspaces.toString(),
        monthlyIngressBytes: monthlyMetrics.get('monthly_ingress_bytes') ?? '0',
        monthlyEgressBytes: monthlyMetrics.get('monthly_egress_bytes') ?? '0',
      },
    }
  }

  /** Append-only egress metering. It intentionally does not participate in
   * admission control until a billing-period limit is introduced. */
  async recordBlobEgress(input: {
    accountId: string
    workspaceId: string
    blobId: string
    bytes: bigint
    requestId: string
  }): Promise<void> {
    if (input.bytes <= 0n) return
    const occurredAt = new Date()
    const billingPeriod = `${occurredAt.getUTCFullYear()}-${String(occurredAt.getUTCMonth() + 1).padStart(2, '0')}`
    await this.database.db.insert(usageEvents).values({
      accountId: input.accountId, workspaceId: input.workspaceId,
      metric: 'monthly_egress_bytes', delta: input.bytes,
      sourceType: 'blob-download', sourceId: input.blobId,
      requestHash: usageEventRequestHash({ metric: 'monthly_egress_bytes', blobId: input.blobId, bytes: input.bytes.toString() }), idempotencyKey: input.requestId,
      billingPeriod, metadata: { transport: 'http' },
    }).onConflictDoNothing()
  }

  async recordBlobIngress(input: {
    accountId: string
    workspaceId: string
    uploadId: string
    partNumber: number
    bytes: bigint
    requestId: string
  }): Promise<void> {
    if (input.bytes <= 0n) return
    const occurredAt = new Date()
    const billingPeriod = `${occurredAt.getUTCFullYear()}-${String(occurredAt.getUTCMonth() + 1).padStart(2, '0')}`
    await this.database.db.insert(usageEvents).values({
      accountId: input.accountId, workspaceId: input.workspaceId,
      metric: 'monthly_ingress_bytes', delta: input.bytes,
      sourceType: 'blob-upload-part', sourceId: `${input.uploadId}:${input.partNumber}`,
      requestHash: usageEventRequestHash({ metric: 'monthly_ingress_bytes', uploadId: input.uploadId, partNumber: input.partNumber, bytes: input.bytes.toString() }), idempotencyKey: input.requestId,
      billingPeriod, metadata: { transport: 'http', partNumber: input.partNumber },
    }).onConflictDoNothing()
  }

  async recordSyncCommandIngress(input: {
    accountId: string
    workspaceId: string
    bytes: bigint
    requestId: string
  }): Promise<void> {
    if (input.bytes <= 0n) return
    const occurredAt = new Date()
    const billingPeriod = `${occurredAt.getUTCFullYear()}-${String(occurredAt.getUTCMonth() + 1).padStart(2, '0')}`
    await this.database.db.insert(usageEvents).values({
      accountId: input.accountId, workspaceId: input.workspaceId,
      metric: 'monthly_ingress_bytes', delta: input.bytes,
      sourceType: 'sync-command-batch', sourceId: input.requestId,
      requestHash: usageEventRequestHash({ metric: 'monthly_ingress_bytes', bytes: input.bytes.toString() }), idempotencyKey: input.requestId,
      billingPeriod, metadata: { transport: 'http' },
    }).onConflictDoNothing()
  }

  /**
   * Rebuilds the current-state counters from the durable tables.  This is an
   * intentionally conservative reconciliation path: it makes the account
   * context truthful while the remaining sync writers are being moved to the
   * same transaction-local UsageGuard as Blob reservations.  It is not a
   * substitute for a hard admission check on a write path.
   */
  async reconcileCurrent(accountId: string): Promise<typeof accountUsage.$inferSelect | undefined> {
    return await this.database.db.transaction(async (tx) => await this.reconcileCurrentInTransaction(tx, accountId))
  }

  /** Rebuilds counters in the caller's domain transaction (for deletion and
   * restore transitions that must not publish a stale quota snapshot). */
  async reconcileCurrentInTransaction(tx: any, accountId: string): Promise<typeof accountUsage.$inferSelect | undefined> {
      await tx.insert(accountUsage).values({ accountId }).onConflictDoNothing()
      const [existing] = await tx.select().from(accountUsage)
        .where(eq(accountUsage.accountId, accountId)).limit(1).for('update')
      if (existing === undefined) return undefined
      const actualRows = await tx.execute(sql<{
        active_object_bytes: string
        active_crdt_bytes: string
        active_blob_bytes: string
        active_objects: string
        active_devices: string
        active_workspaces: string
      }>`
        select
          coalesce((select sum((length(o.ciphertext) * 3) / 4)::bigint
            from objects o join workspaces w on w.id = o.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null and o.deleted_at is null), 0)::text as active_object_bytes,
          (coalesce((select sum((length(d.checkpoint_ciphertext) * 3) / 4)::bigint
            from sync_v2_documents d join workspaces w on w.id = d.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null and d.checkpoint_ciphertext is not null), 0)
          + coalesce((select sum((length(u.ciphertext) * 3) / 4)::bigint
            from sync_v2_updates u join workspaces w on w.id = u.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null), 0))::text as active_crdt_bytes,
          coalesce((select sum(b.size)::bigint from blobs b join workspaces w on w.id = b.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null and b.state = 'ready'), 0)::text as active_blob_bytes,
          coalesce((select count(*) from objects o join workspaces w on w.id = o.workspace_id
            where w.account_id = ${accountId} and w.deleted_at is null and o.deleted_at is null), 0)::text as active_objects,
          coalesce((select count(*) from devices d where d.account_id = ${accountId} and d.revoked_at is null), 0)::text as active_devices,
          coalesce((select count(*) from workspaces w where w.account_id = ${accountId} and w.deleted_at is null), 0)::text as active_workspaces`)
      const actual = actualRows[0]
      if (actual === undefined) throw new Error('Usage reconciliation query returned no row')
      const changed = existing.activeObjectBytes !== BigInt(actual.active_object_bytes)
        || existing.activeCrdtBytes !== BigInt(actual.active_crdt_bytes)
        || existing.activeBlobBytes !== BigInt(actual.active_blob_bytes)
        || existing.activeObjects !== BigInt(actual.active_objects)
        || existing.activeDevices !== BigInt(actual.active_devices)
        || existing.activeWorkspaces !== BigInt(actual.active_workspaces)
      const [row] = await tx.update(accountUsage).set({
        ...(changed ? {
          activeObjectBytes: BigInt(actual.active_object_bytes), activeBlobBytes: BigInt(actual.active_blob_bytes),
          activeCrdtBytes: BigInt(actual.active_crdt_bytes),
          activeObjects: BigInt(actual.active_objects), activeDevices: BigInt(actual.active_devices),
          activeWorkspaces: BigInt(actual.active_workspaces), revision: sql`${accountUsage.revision} + 1`,
        } : {}),
        reconciledAt: new Date(), updatedAt: new Date(),
      }).where(eq(accountUsage.accountId, accountId)).returning()
      return row
  }

  async reserveBlob(input: {
    accountId: string
    workspaceId: string
    sourceId: string
    requestHash: string
    bytes: bigint
    storageLimit: bigint | null
    expiresAt: Date
  }): Promise<{ reservationId: string, created: boolean }> {
    if (input.bytes <= 0n) throw new ApiError({ code: 'quota_invalid_request', message: 'Reserved bytes must be positive', statusCode: 400 })
    return await this.database.db.transaction(async (tx) => {
      await tx.insert(accountUsage).values({ accountId: input.accountId }).onConflictDoNothing()
      const [existing] = await tx.select({
        id: usageReservations.id, requestHash: usageReservations.requestHash, quantity: usageReservations.quantity,
        status: usageReservations.status,
      })
        .from(usageReservations).where(and(
          eq(usageReservations.accountId, input.accountId), eq(usageReservations.workspaceId, input.workspaceId),
          eq(usageReservations.sourceType, 'blob-upload'), eq(usageReservations.sourceId, input.sourceId), eq(usageReservations.metric, 'active_blob_bytes'),
        )).limit(1)
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) throw new ApiError({ code: 'idempotency_conflict', message: 'Upload source was reused with a different request', statusCode: 409 })
        if (existing.quantity !== input.bytes) throw new ApiError({ code: 'idempotency_conflict', message: 'Upload source was reused with a different size', statusCode: 409 })
        if (existing.status === 'reserved' || existing.status === 'external_started') return { reservationId: existing.id, created: false }
        if (existing.status === 'committed') throw new ApiError({ code: 'usage_reservation_committed', message: 'Upload reservation is already committed', statusCode: 409 })
        await reserveBytes(tx, input.accountId, input.bytes, input.storageLimit)
        await tx.update(usageReservations).set({ status: 'reserved', expiresAt: input.expiresAt, completedAt: null })
          .where(eq(usageReservations.id, existing.id))
        return { reservationId: existing.id, created: true }
      }
      await reserveBytes(tx, input.accountId, input.bytes, input.storageLimit)
      const [reservation] = await tx.insert(usageReservations).values({
        accountId: input.accountId, workspaceId: input.workspaceId, metric: 'active_blob_bytes', quantity: input.bytes,
        sourceType: 'blob-upload', sourceId: input.sourceId, requestHash: input.requestHash, status: 'reserved', expiresAt: input.expiresAt,
      }).returning({ id: usageReservations.id })
      if (reservation === undefined) throw new Error('Usage reservation insert returned no row')
      return { reservationId: reservation.id, created: true }
    })
  }

  /** Account locking belongs to the caller; this counter update is its CAS admission point. */
  async admitDevice(
    tx: Pick<DatabaseContext['db'], 'insert' | 'update'>,
    accountId: string,
    limit: bigint | null,
  ): Promise<void> {
    await tx.insert(accountUsage).values({ accountId }).onConflictDoNothing()
    const updated = await tx.update(accountUsage).set({
      activeDevices: sql`${accountUsage.activeDevices} + 1`, revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
    }).where(and(
      eq(accountUsage.accountId, accountId),
      ...(limit === null ? [] : [sql`${accountUsage.activeDevices} < ${limit}`]),
    )).returning({ accountId: accountUsage.accountId })
    if (updated.length !== 1) {
      throw new ApiError({
        code: 'device_limit_exceeded', message: 'Device limit is exceeded', statusCode: 409,
        details: limit === null ? undefined : { metric: 'devices', limit: limit.toString() },
      })
    }
  }

  async releaseDevice(tx: Pick<DatabaseContext['db'], 'update'>, accountId: string): Promise<void> {
    await tx.update(accountUsage).set({
      activeDevices: sql`greatest(0, ${accountUsage.activeDevices} - 1)`,
      revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
    }).where(eq(accountUsage.accountId, accountId))
  }

  async admitWorkspace(
    tx: Pick<DatabaseContext['db'], 'insert' | 'update'>,
    accountId: string,
    limit: bigint | null,
  ): Promise<void> {
    await tx.insert(accountUsage).values({ accountId }).onConflictDoNothing()
    const updated = await tx.update(accountUsage).set({
      activeWorkspaces: sql`${accountUsage.activeWorkspaces} + 1`, revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
    }).where(and(
      eq(accountUsage.accountId, accountId),
      ...(limit === null ? [] : [sql`${accountUsage.activeWorkspaces} < ${limit}`]),
    )).returning({ accountId: accountUsage.accountId })
    if (updated.length !== 1) {
      throw new ApiError({
        code: 'workspace_limit_exceeded', message: 'Workspace limit is exceeded', statusCode: 409,
        details: limit === null ? undefined : { metric: 'workspaces', limit: limit.toString() },
      })
    }
  }

  async releaseWorkspace(tx: Pick<DatabaseContext['db'], 'update'>, accountId: string): Promise<void> {
    await tx.update(accountUsage).set({
      activeWorkspaces: sql`greatest(0, ${accountUsage.activeWorkspaces} - 1)`,
      revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
    }).where(eq(accountUsage.accountId, accountId))
  }

  /** Applies one current-object replacement in the same transaction as its version write. */
  async applyCurrentObject(
    tx: Pick<DatabaseContext['db'], 'insert' | 'update'>,
    input: { accountId: string, previousBytes: bigint, previousActive: boolean, nextBytes: bigint, nextActive: boolean, storageLimit: bigint | null },
  ): Promise<void> {
    await tx.insert(accountUsage).values({ accountId: input.accountId }).onConflictDoNothing()
    const byteDelta = (input.nextActive ? input.nextBytes : 0n) - (input.previousActive ? input.previousBytes : 0n)
    const objectDelta = (input.nextActive ? 1n : 0n) - (input.previousActive ? 1n : 0n)
    const updated = await tx.update(accountUsage).set({
      activeObjectBytes: sql`greatest(0, ${accountUsage.activeObjectBytes} + ${byteDelta})`,
      activeObjects: sql`greatest(0, ${accountUsage.activeObjects} + ${objectDelta})`,
      revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
    }).where(and(
      eq(accountUsage.accountId, input.accountId),
      ...(input.storageLimit === null || byteDelta <= 0n ? [] : [sql`${accountUsage.activeObjectBytes} + ${accountUsage.activeCrdtBytes} + ${accountUsage.activeBlobBytes} + ${accountUsage.reservedBlobBytes} + ${byteDelta} <= ${input.storageLimit}`]),
    )).returning({ accountId: accountUsage.accountId })
    if (updated.length !== 1) {
      throw new ApiError({
        code: 'quota_exceeded', message: 'Storage quota is exceeded', statusCode: 409,
        details: { metric: 'storage_bytes', limit: input.storageLimit?.toString() },
      })
    }
  }

  /** CRDT active state is the latest checkpoint plus unpruned updates. */
  async applyActiveCrdtDelta(
    tx: Pick<DatabaseContext['db'], 'insert' | 'update'>,
    accountId: string,
    byteDelta: bigint,
    storageLimit: bigint | null,
  ): Promise<void> {
    await tx.insert(accountUsage).values({ accountId }).onConflictDoNothing()
    const updated = await tx.update(accountUsage).set({
      activeCrdtBytes: sql`greatest(0, ${accountUsage.activeCrdtBytes} + ${byteDelta})`,
      revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
    }).where(and(
      eq(accountUsage.accountId, accountId),
      ...(storageLimit === null || byteDelta <= 0n ? [] : [sql`${accountUsage.activeObjectBytes} + ${accountUsage.activeCrdtBytes} + ${accountUsage.activeBlobBytes} + ${accountUsage.reservedBlobBytes} + ${byteDelta} <= ${storageLimit}`]),
    )).returning({ accountId: accountUsage.accountId })
    if (updated.length !== 1) {
      throw new ApiError({ code: 'quota_exceeded', message: 'Storage quota is exceeded', statusCode: 409,
        details: { metric: 'storage_bytes', limit: storageLimit?.toString() } })
    }
  }

  async releaseReservation(reservationId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [reservation] = await tx.select().from(usageReservations).where(eq(usageReservations.id, reservationId)).limit(1)
      if (reservation === undefined || reservation.status === 'released' || reservation.status === 'committed') return
      const changed = await tx.update(usageReservations).set({ status: 'released', completedAt: new Date() }).where(and(eq(usageReservations.id, reservationId), eq(usageReservations.status, reservation.status))).returning({ id: usageReservations.id })
      if (changed.length === 0) return
      await tx.update(accountUsage).set({ reservedBlobBytes: sql`greatest(0, ${accountUsage.reservedBlobBytes} - ${reservation.quantity})`, revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date() }).where(eq(accountUsage.accountId, reservation.accountId))
    })
  }

  async markExternalStarted(reservationId: string): Promise<void> {
    await this.database.db.update(usageReservations).set({ status: 'external_started' }).where(and(
      eq(usageReservations.id, reservationId), eq(usageReservations.status, 'reserved'),
    ))
  }

  async commitBlobReservation(
    tx: Pick<DatabaseContext['db'], 'select' | 'update'>,
    reservationId: string,
    expectedBytes: bigint,
  ): Promise<void> {
    const [reservation] = await tx.select().from(usageReservations).where(eq(usageReservations.id, reservationId)).limit(1)
    if (reservation === undefined) throw new Error(`Usage reservation ${reservationId} is missing`)
    if (reservation.status === 'committed') return
    if (reservation.status !== 'reserved' && reservation.status !== 'external_started') {
      throw new ApiError({ code: 'usage_reservation_invalid', message: 'Blob upload reservation cannot be committed', statusCode: 409 })
    }
    if (reservation.quantity !== expectedBytes) throw new Error(`Usage reservation ${reservationId} size does not match completed blob`)
    const [claimed] = await tx.update(usageReservations).set({ status: 'committed', completedAt: new Date() }).where(and(
      eq(usageReservations.id, reservationId), eq(usageReservations.status, reservation.status),
    )).returning({ id: usageReservations.id })
    if (claimed === undefined) throw new ApiError({ code: 'usage_reservation_raced', message: 'Blob usage reservation changed while completing upload', statusCode: 409, retryable: true })
    await tx.update(accountUsage).set({
      reservedBlobBytes: sql`greatest(0, ${accountUsage.reservedBlobBytes} - ${reservation.quantity})`,
      activeBlobBytes: sql`${accountUsage.activeBlobBytes} + ${reservation.quantity}`,
      revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
    }).where(eq(accountUsage.accountId, reservation.accountId))
  }
}

async function reserveBytes(
  tx: Pick<DatabaseContext['db'], 'update'>,
  accountId: string,
  bytes: bigint,
  storageLimit: bigint | null,
): Promise<void> {
  if (storageLimit !== null) {
    const admitted = await tx.update(accountUsage).set({
      reservedBlobBytes: sql`${accountUsage.reservedBlobBytes} + ${bytes}`,
      revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
    }).where(and(eq(accountUsage.accountId, accountId), sql`${accountUsage.activeObjectBytes} + ${accountUsage.activeCrdtBytes} + ${accountUsage.activeBlobBytes} + ${accountUsage.reservedBlobBytes} + ${bytes} <= ${storageLimit}`)).returning({ accountId: accountUsage.accountId })
    if (admitted.length !== 1) throw new ApiError({ code: 'quota_exceeded', message: 'Storage quota is exceeded', statusCode: 409, details: { metric: 'storage_bytes', limit: storageLimit.toString() } })
    return
  }
  await tx.update(accountUsage).set({
    reservedBlobBytes: sql`${accountUsage.reservedBlobBytes} + ${bytes}`,
    revision: sql`${accountUsage.revision} + 1`, updatedAt: new Date(),
  }).where(eq(accountUsage.accountId, accountId))
}

function usageEventRequestHash(value: Record<string, string | number>): string {
  const canonical = Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url')
}
