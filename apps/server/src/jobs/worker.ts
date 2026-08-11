import { randomUUID } from 'node:crypto'
import type { MaintenanceCoordinator } from '../maintenance/coordinator.js'
import type { ClaimedJob, BackgroundJobService } from './service.js'

export interface JobHandler {
  readonly type: string
  execute(job: ClaimedJob): Promise<Record<string, unknown> | void>
}

/** A handler may explicitly make a failure terminal or defer its next retry. */
export class JobExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = true,
    readonly retryDelaySeconds?: number,
  ) {
    super(code)
  }
}

export interface BackgroundJobWorkerOptions {
  readonly workerId?: string
  /** Process-wide handler contract version used by rolling-deployment fences. */
  readonly handlerVersion?: number
  readonly queueGeneration?: number
  readonly leaseSeconds?: number
  readonly pollIntervalMs?: number
  readonly maintenanceCoordinator?: MaintenanceCoordinator
  readonly onError?: (error: unknown) => void
}

/**
 * Versioned, at-least-once durable job runner. The allowlist is derived from
 * registered handlers, so a rolling deployment leaves unknown/future work
 * queued instead of letting an old binary execute or discard it.
 */
export class BackgroundJobWorker {
  #timer: NodeJS.Timeout | undefined
  #running = false
  readonly #handlers: Map<string, JobHandler>
  readonly #workerId: string
  readonly #handlerVersion: number
  readonly #queueGeneration: number
  readonly #leaseSeconds: number
  readonly #pollIntervalMs: number

  constructor(
    private readonly jobs: BackgroundJobService,
    handlers: readonly JobHandler[],
    private readonly options: BackgroundJobWorkerOptions = {},
  ) {
    this.#handlers = new Map(handlers.map((handler) => [handler.type, handler]))
    if (this.#handlers.size !== handlers.length) throw new Error('Duplicate durable job handler type')
    this.#workerId = options.workerId ?? `jobs:${process.pid}:${randomUUID()}`
    this.#handlerVersion = Math.max(1, options.handlerVersion ?? 1)
    this.#queueGeneration = options.queueGeneration ?? 1
    this.#leaseSeconds = Math.max(5, options.leaseSeconds ?? 60)
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000)
  }

  start(): () => void {
    if (this.#timer !== undefined) return () => this.stop()
    this.#timer = setInterval(() => void this.runOnce().catch((error: unknown) => this.options.onError?.(error)), this.#pollIntervalMs)
    this.#timer.unref()
    void this.runOnce().catch((error: unknown) => this.options.onError?.(error))
    return () => this.stop()
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async runOnce(): Promise<boolean> {
    if (this.#running || this.#handlers.size === 0) return false
    if (this.options.maintenanceCoordinator !== undefined
      && (await this.options.maintenanceCoordinator.getSnapshot()).mode !== 'normal') return false
    this.#running = true
    try {
      const job = await this.jobs.claim(
        this.#workerId,
        this.#handlerVersion,
        [...this.#handlers.keys()],
        this.#leaseSeconds,
        this.#queueGeneration,
      )
      if (job === undefined) return false
      const handler = this.#handlers.get(job.type)
      if (handler === undefined) {
        await this.jobs.deadLetter(job.id, this.#workerId, 'handler_not_registered')
        return true
      }
      try {
        await this.jobs.succeed(job.id, this.#workerId, await handler.execute(job) ?? {})
      } catch (error) {
        const failure = error instanceof JobExecutionError
          ? error
          : new JobExecutionError('handler_failed')
        if (!failure.retryable) {
          await this.jobs.deadLetter(job.id, this.#workerId, failure.code)
        } else {
          await this.jobs.fail(job, this.#workerId, failure.code, failure.retryDelaySeconds ?? retryDelaySeconds(job.attempt))
        }
      }
      return true
    } finally {
      this.#running = false
    }
  }
}

function retryDelaySeconds(attempt: number): number {
  const base = Math.min(60 * 60, 15 * 2 ** Math.max(0, attempt - 1))
  return base + Math.floor(Math.random() * Math.max(1, Math.ceil(base / 4)))
}
