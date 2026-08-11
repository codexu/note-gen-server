import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import type { AppConfig } from '../config.js'
import { assertMigrationCompatibility } from './migration-compatibility.js'
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

  const context: DatabaseContext = {
    db,
    sql: sqlClient,
    async check() {
      await sqlClient`select is_default from workspaces limit 0`
      await sqlClient`select is_admin, suspended_at from accounts limit 0`
      await sqlClient`select id from admin_audit_logs limit 0`
      await sqlClient`select id, actor_type from account_service_audit_events limit 0`
      await sqlClient`select id, scope_version, deleted_at from support_diagnostic_grants limit 0`
      await sqlClient`select 'managed'::key_envelope_type`
      // Account-service migrations are a readiness contract, not optional tables.
      await sqlClient`select deployment_mode, registration_policy, runtime_configuration, instance_auth_epoch, token_not_before, auth_epoch_enforced from deployment_settings limit 0`
      await sqlClient`select normalized_login_key from account_login_claims limit 0`
      await sqlClient`select id, actor_type from step_up_grants limit 0`
      await sqlClient`select local_login, local_password_hash from staff_principals limit 0`
      await sqlClient`select csrf_token_hash from staff_sessions limit 0`
      await sqlClient`select id from background_jobs limit 0`
      await sqlClient`select id, sanitation_status from restore_markers limit 0`
      await sqlClient`select mode, generation from maintenance_state limit 0`
      await sqlClient`select account_id, revision from account_usage limit 0`
      await sqlClient`select 'account'::step_up_actor_type, 'pending'::background_job_status, 'complete'::restore_sanitation_status, 'offline'::maintenance_mode`
      // A binary can remain alive while an operator changes the database. Do
      // not report it ready if the ordered migration contract has since moved
      // behind, ahead, or drifted from this process's known schema.
      await assertMigrationCompatibility(context)
    },
    async close() { await sqlClient.end({ timeout: 5 }) },
  }
  return context
}
