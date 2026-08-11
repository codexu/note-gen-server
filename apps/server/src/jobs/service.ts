import { and, eq, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { backgroundJobs } from '../database/schema.js'
import { ApiError } from '../errors.js'

export interface EnqueueJobInput {
  type: string
  category: string
  payload: Record<string, unknown>
  payloadVersion: number
  requestHash: string
  idempotencyKey: string
  maxAttempts?: number
  scheduledAt?: Date
  queueGeneration?: number
  minHandlerVersion?: number
  actorAccountId?: string
  targetAccountId?: string
}

export interface ClaimedJob {
  id: string
  type: string
  category: string
  payload: Record<string, unknown>
  payloadVersion: number
  requestHash: string
  attempt: number
  maxAttempts: number
}

/** PostgreSQL-backed at-least-once job coordination with expiring leases. */
export class BackgroundJobService {
  constructor(private readonly database: DatabaseContext) {}

  async enqueue(input: EnqueueJobInput): Promise<{ id: string, created: boolean }> {
    const maxAttempts = positiveInteger(input.maxAttempts ?? 10, 'max_attempts')
    const queueGeneration = positiveInteger(input.queueGeneration ?? 1, 'queue_generation')
    const minHandlerVersion = positiveInteger(input.minHandlerVersion ?? 1, 'min_handler_version')
    const payloadVersion = positiveInteger(input.payloadVersion, 'payload_version')
    return await this.database.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: backgroundJobs.id, requestHash: backgroundJobs.requestHash })
        .from(backgroundJobs).where(and(eq(backgroundJobs.type, input.type), eq(backgroundJobs.idempotencyKey, input.idempotencyKey))).limit(1)
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) {
          throw new ApiError({ code: 'idempotency_conflict', message: 'Idempotency key was used with a different request', statusCode: 409 })
        }
        return { id: existing.id, created: false }
      }
      const [created] = await tx.insert(backgroundJobs).values({
        type: input.type, category: input.category, payload: input.payload,
        requestHash: input.requestHash, idempotencyKey: input.idempotencyKey, maxAttempts,
        scheduledAt: input.scheduledAt, queueGeneration,
        minHandlerVersion, payloadVersion,
        actorAccountId: input.actorAccountId, targetAccountId: input.targetAccountId,
      }).returning({ id: backgroundJobs.id })
      if (created === undefined) throw new Error('Job insert returned no row')
      return { id: created.id, created: true }
    })
  }

  /** A worker must declare its compatible task types; unknown work stays queued. */
  async claim(
    workerId: string,
    handlerVersion: number,
    handlerTypes: readonly string[],
    leaseSeconds = 60,
    queueGeneration = 1,
  ): Promise<ClaimedJob | undefined> {
    if (handlerTypes.length === 0) return undefined
    // A process can die after incrementing attempt but before it reports a
    // failure. Without this terminalization, its expired final lease would be
    // reclaimed forever and silently exceed the durable retry budget.
    await this.database.db.update(backgroundJobs).set({
      status: 'dead_letter', errorCode: 'lease_expired_max_attempts', finishedAt: new Date(),
      lockedAt: null, lockedBy: null, leaseExpiresAt: null,
    }).where(and(
      sql`${backgroundJobs.attempt} >= ${backgroundJobs.maxAttempts}`,
      sql`(( ${backgroundJobs.status} = 'running' and ${backgroundJobs.leaseExpiresAt} < now()) or ${backgroundJobs.status} = 'pending')`,
    ))
    const allowedTypes = this.database.sql.array([...new Set(handlerTypes)], 'text')
    const rows = await this.database.sql<Array<ClaimedJob>>`
      with candidate as (
        select id from background_jobs
        where (
          (status = 'pending' and scheduled_at <= now())
          or (status = 'running' and lease_expires_at < now())
        ) and attempt < max_attempts and min_handler_version <= ${handlerVersion}
          and queue_generation = ${queueGeneration}
          and type = any(${allowedTypes})
        order by scheduled_at asc, created_at asc
        for update skip locked
        limit 1
      )
      update background_jobs job
      set status = 'running', locked_at = now(), locked_by = ${workerId},
          lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
          attempt = job.attempt + 1, started_at = coalesce(job.started_at, now())
      from candidate
      where job.id = candidate.id
      returning job.id, job.type, job.category, job.payload, job.payload_version as "payloadVersion",
        job.request_hash as "requestHash", job.attempt, job.max_attempts as "maxAttempts"`
    return rows[0]
  }

  async succeed(jobId: string, workerId: string, result: Record<string, unknown> = {}): Promise<boolean> {
    const changed = await this.database.db.update(backgroundJobs).set({
      status: 'succeeded', result, finishedAt: new Date(), leaseExpiresAt: null,
    }).where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.status, 'running'), eq(backgroundJobs.lockedBy, workerId)))
      .returning({ id: backgroundJobs.id })
    return changed.length === 1
  }

  async fail(job: ClaimedJob, workerId: string, errorCode: string, retryDelaySeconds: number): Promise<boolean> {
    const changed = await this.database.db.update(backgroundJobs).set({
      status: sql`case when ${backgroundJobs.attempt} >= ${backgroundJobs.maxAttempts} then 'dead_letter'::background_job_status else 'pending'::background_job_status end`,
      errorCode,
      scheduledAt: sql`now() + (${Math.max(1, retryDelaySeconds)} * interval '1 second')`,
      lockedAt: null, lockedBy: null, leaseExpiresAt: null,
      finishedAt: sql`case when ${backgroundJobs.attempt} >= ${backgroundJobs.maxAttempts} then now() else null end`,
    }).where(and(eq(backgroundJobs.id, job.id), eq(backgroundJobs.status, 'running'), eq(backgroundJobs.lockedBy, workerId)))
      .returning({ id: backgroundJobs.id })
    return changed.length === 1
  }

  async deadLetter(jobId: string, workerId: string, errorCode: string): Promise<boolean> {
    const changed = await this.database.db.update(backgroundJobs).set({
      status: 'dead_letter', errorCode, finishedAt: new Date(),
      lockedAt: null, lockedBy: null, leaseExpiresAt: null,
    }).where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.status, 'running'), eq(backgroundJobs.lockedBy, workerId)))
      .returning({ id: backgroundJobs.id })
    return changed.length === 1
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ApiError({ code: 'invalid_job_contract', message: `${field} must be a positive integer`, statusCode: 400 })
  }
  return value
}
