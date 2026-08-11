import { eq, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { maintenanceState } from '../database/schema.js'
import { ApiError } from '../errors.js'

export type MaintenanceMode = 'normal' | 'read_only' | 'write_drain' | 'offline'

export interface MaintenanceSnapshot {
  mode: MaintenanceMode
  generation: string
  reason: string | null
  enteredAt: Date | null
}

/**
 * The single cross-process source of truth for maintenance fencing. It has no
 * process cache: a server must observe an enabled barrier before admitting a
 * subsequent mutating HTTP request.
 */
export class MaintenanceCoordinator {
  constructor(private readonly database: DatabaseContext) {}

  async getSnapshot(): Promise<MaintenanceSnapshot> {
    const [state] = await this.database.db.select().from(maintenanceState).where(eq(maintenanceState.id, true)).limit(1)
    if (state === undefined) throw new Error('Maintenance singleton is missing')
    return toSnapshot(state)
  }

  async enable(mode: Exclude<MaintenanceMode, 'normal'>, reason: string): Promise<MaintenanceSnapshot> {
    const normalizedReason = reason.trim()
    if (normalizedReason.length === 0 || normalizedReason.length > 500) throw new Error('Maintenance reason must contain 1 to 500 characters')
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-maintenance-state'))`)
      const now = new Date()
      const [state] = await tx.update(maintenanceState).set({
        mode, reason: normalizedReason, enteredAt: now, updatedAt: now,
        generation: sql`${maintenanceState.generation} + 1`,
      }).where(eq(maintenanceState.id, true)).returning()
      if (state === undefined) throw new Error('Maintenance singleton is missing')
      return toSnapshot(state)
    })
  }

  async disable(): Promise<MaintenanceSnapshot> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-maintenance-state'))`)
      const now = new Date()
      const [state] = await tx.update(maintenanceState).set({
        mode: 'normal', reason: null, enteredAt: null, updatedAt: now,
        generation: sql`${maintenanceState.generation} + 1`,
      }).where(eq(maintenanceState.id, true)).returning()
      if (state === undefined) throw new Error('Maintenance singleton is missing')
      return toSnapshot(state)
    })
  }

  async requireMutationAllowed(requestPath: string): Promise<void> {
    const state = await this.getSnapshot()
    if (state.mode === 'normal') return
    // Read-only explicitly permits refresh rotation to avoid turning a planned
    // read window into a surprising account logout event. write_drain blocks it.
    if (state.mode === 'read_only' && requestPath === '/v1/auth/refresh') return
    throw new ApiError({
      code: 'server_maintenance', message: 'Server writes are temporarily unavailable for maintenance', statusCode: 503,
      retryable: true, details: { mode: state.mode, generation: state.generation, retryAfterSeconds: 60 },
    })
  }

  async requireServingAllowed(requestPath: string): Promise<void> {
    const state = await this.getSnapshot()
    if (state.mode !== 'offline' || requestPath === '/health/live' || requestPath === '/health/ready') return
    throw new ApiError({
      code: 'server_maintenance', message: 'Server is offline for maintenance', statusCode: 503,
      retryable: true, details: { mode: state.mode, generation: state.generation, retryAfterSeconds: 60 },
    })
  }
}

function toSnapshot(row: typeof maintenanceState.$inferSelect): MaintenanceSnapshot {
  return { mode: row.mode, generation: row.generation.toString(), reason: row.reason, enteredAt: row.enteredAt }
}
