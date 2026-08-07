import type { RouteOptions } from 'fastify'
import type {
  FastifyRateLimitOptions, FastifyRateLimitStore, FastifyRateLimitStoreCtor,
} from '@fastify/rate-limit'
import type { DatabaseContext } from '../database/client.js'

export function createPostgresRateLimitStore(database: DatabaseContext): FastifyRateLimitStoreCtor {
  class PostgresRateLimitStore implements FastifyRateLimitStore {
    readonly #scope: string

    constructor(_options: FastifyRateLimitOptions, scope = 'global') {
      this.#scope = scope
    }

    child(route: RouteOptions & { path: string, prefix: string }): FastifyRateLimitStore {
      const runtime = route as unknown as {
        routeInfo?: { method?: string | string[], url?: string, path?: string, prefix?: string }
      }
      const info = runtime.routeInfo ?? route
      return new PostgresRateLimitStore(
        {} as FastifyRateLimitOptions,
        `${String(info.method ?? 'ANY')}:${info.url ?? `${info.prefix ?? ''}${info.path ?? ''}`}`,
      )
    }

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number, ttl: number }) => void,
      timeWindow: number,
      _max: number,
    ): void {
      void this.#increment(key, timeWindow).then(
        (result) => callback(null, result),
        (error: unknown) => callback(error instanceof Error ? error : new Error('Rate limit store failed')),
      )
    }

    async #increment(key: string, timeWindow: number): Promise<{ current: number, ttl: number }> {
      const now = Date.now()
      const windowStart = new Date(Math.floor(now / timeWindow) * timeWindow)
      const expiresAt = new Date(windowStart.getTime() + timeWindow)
      const [row] = await database.sql<Array<{ hits: number }>>`
        insert into rate_limit_buckets (scope, rate_key, window_start, expires_at, hits)
        values (
          ${this.#scope}, ${key},
          ${windowStart.toISOString()}::timestamptz,
          ${expiresAt.toISOString()}::timestamptz,
          1
        )
        on conflict (scope, rate_key, window_start)
        do update set hits = rate_limit_buckets.hits + 1
        returning hits`
      if (row === undefined) throw new Error('Rate limit counter update returned no row')
      return { current: row.hits, ttl: Math.max(0, expiresAt.getTime() - now) }
    }
  }

  return PostgresRateLimitStore
}
