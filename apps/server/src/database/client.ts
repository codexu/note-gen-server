import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import type { AppConfig } from '../config.js'
import * as schema from './schema.js'

export interface DatabaseHealth {
  check(): Promise<void>
  close(): Promise<void>
}

export interface DatabaseContext extends DatabaseHealth {
  readonly db: PostgresJsDatabase<typeof schema>
  readonly sql: Sql
}

export function createDatabase(config: AppConfig): DatabaseContext {
  const sqlClient = postgres(config.databaseUrl, { max: config.databasePoolSize, prepare: false })
  const db = drizzle(sqlClient, { schema })

  return {
    db,
    sql: sqlClient,
    async check() {
      await sqlClient`select is_default from workspaces limit 0`
      await sqlClient`select is_admin, suspended_at from accounts limit 0`
      await sqlClient`select id from admin_audit_logs limit 0`
      await sqlClient`select 'managed'::key_envelope_type`
    },
    async close() { await sqlClient.end({ timeout: 5 }) },
  }
}
