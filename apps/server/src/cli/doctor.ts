import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'

interface DoctorCheck { id: string, status: 'ok' | 'warning' | 'blocking', detail: string }
interface MigrationEntry { tag: string, when: string, hash: string }
interface MigrationSet { count: number, hash: string, missing: string[], entries: MigrationEntry[] }

async function main(): Promise<void> {
  const config = loadConfig()
  const database = createDatabase({ ...config, databasePoolSize: 1 })
  const checks: DoctorCheck[] = []
  try {
    const migrations = await readMigrationSet()
    checks.push(migrations.missing.length === 0
      ? { id: 'migration_files', status: 'ok', detail: `${migrations.count} migration files; set ${migrations.hash.slice(0, 16)}` }
      : { id: 'migration_files', status: 'blocking', detail: `Journal entries missing SQL files: ${migrations.missing.join(', ')}` })
    try {
      await database.check()
      checks.push({ id: 'database_core', status: 'ok', detail: 'Core schema objects are readable' })
    } catch (error) {
      checks.push({ id: 'database_core', status: 'blocking', detail: errorMessage(error) })
    }
    await checkDatabaseState(database, config.deploymentMode, migrations, checks)
    const blocking = checks.some(check => check.status === 'blocking')
    const result = {
      status: blocking ? 'blocked' : checks.some(check => check.status === 'warning') ? 'warning' : 'ok',
      server: { deploymentMode: config.deploymentMode, releaseStage: config.hostedReleaseStage },
      migrationSet: { count: migrations.count, hash: migrations.hash, journalMissingFiles: migrations.missing },
      checks,
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (blocking) process.exitCode = 2
  } finally {
    await database.close()
  }
}

async function checkDatabaseState(
  database: ReturnType<typeof createDatabase>,
  configuredDeploymentMode: 'hosted' | 'self-hosted',
  migrations: MigrationSet,
  checks: DoctorCheck[],
): Promise<void> {
  try {
    const applied = await database.sql<Array<{ hash: string, created_at: string }>>`
      select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at asc, id asc`
    checks.push(compareMigrationSet(migrations, applied))
  } catch (error) {
    checks.push({ id: 'database_migrations', status: 'blocking', detail: `Cannot read drizzle migration table: ${errorMessage(error)}` })
  }
  try {
    const [settings] = await database.sql<Array<{ deployment_mode: string, registration_policy: string, admin_repair_required: boolean, instance_auth_epoch: string, token_not_before: string, auth_epoch_enforced: boolean }>>`
      select deployment_mode, registration_policy, admin_repair_required, instance_auth_epoch::text, token_not_before::text, auth_epoch_enforced from deployment_settings where id = true`
    if (settings === undefined) checks.push({ id: 'deployment_settings', status: 'blocking', detail: 'Deployment singleton is missing' })
    else {
      const modeStatus = settings.deployment_mode === configuredDeploymentMode
        ? settings.admin_repair_required ? 'warning' : 'ok'
        : 'blocking'
      checks.push({
        id: 'deployment_settings', status: modeStatus,
        detail: settings.deployment_mode === configuredDeploymentMode
          ? `${settings.deployment_mode}/${settings.registration_policy}${settings.admin_repair_required ? '; administrator repair required' : ''}`
          : `deployment_mode_mismatch: database=${settings.deployment_mode}; configured=${configuredDeploymentMode}`,
      })
    }
    if (settings === undefined || !/^(0|[1-9][0-9]*)$/.test(settings.instance_auth_epoch) || !Number.isFinite(Date.parse(settings.token_not_before))) {
      checks.push({ id: 'instance_auth_epoch', status: 'blocking', detail: 'Instance authentication epoch state is missing or invalid' })
    } else {
      checks.push({ id: 'instance_auth_epoch', status: settings.auth_epoch_enforced ? 'ok' : 'warning', detail: `epoch ${settings.instance_auth_epoch}; enforcement ${settings.auth_epoch_enforced ? 'enabled' : 'not yet enabled'}` })
    }
  } catch (error) {
    checks.push({ id: 'deployment_settings', status: 'blocking', detail: errorMessage(error) })
    checks.push({ id: 'instance_auth_epoch', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [pending] = await database.sql<Array<{ count: number }>>`select count(*)::integer as count from restore_markers where sanitation_status <> 'complete'`
    checks.push((pending?.count ?? 0) === 0
      ? { id: 'restore_fence', status: 'ok', detail: 'No pending restore sanitation' }
      : { id: 'restore_fence', status: 'blocking', detail: `${pending?.count ?? 0} restore markers require sanitation` })
  } catch (error) {
    checks.push({ id: 'restore_fence', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [reviews] = await database.sql<Array<{ pending: number, active_admins: number }>>`
      select
        (select count(*)::integer from risk_restrictions r
          where r.subject_type = 'account' and r.scope = 'authentication' and r.action = 'review'
            and r.reason_code = 'credential_review_required' and r.revoked_at is null
        ) as pending,
        (select count(*)::integer from accounts a
          where a.is_admin and a.disabled_at is null and a.suspended_at is null
            and not exists (
              select 1 from risk_restrictions pending
              where pending.subject_type = 'account' and pending.subject_ref = a.id::text
                and pending.scope = 'authentication' and pending.action = 'review'
                and pending.reason_code = 'credential_review_required' and pending.revoked_at is null
            )
        ) as active_admins`
    const pending = reviews?.pending ?? 0
    const activeAdmins = reviews?.active_admins ?? 0
    checks.push(pending === 0
      ? { id: 'restore_credential_review', status: 'ok', detail: 'No restored credentials await review' }
      : { id: 'restore_credential_review', status: activeAdmins > 0 ? 'warning' : 'blocking', detail: `${pending} accounts await local credential review; ${activeAdmins} reviewed active administrators` })
  } catch (error) {
    checks.push({ id: 'restore_credential_review', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [epoch] = await database.sql<Array<{ value: string }>>`select value from server_metadata where key = 'sync_epoch'`
    const valid = epoch !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(epoch.value)
    checks.push(valid
      ? { id: 'sync_epoch', status: 'ok', detail: 'Restore fencing epoch is present' }
      : { id: 'sync_epoch', status: 'blocking', detail: 'sync_epoch is missing or invalid; do not serve restored sync state' })
  } catch (error) {
    checks.push({ id: 'sync_epoch', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [jobs] = await database.sql<Array<{ pending: number, dead: number, expired: number }>>`
      select count(*) filter (where status in ('pending', 'running'))::integer as pending,
        count(*) filter (where status = 'dead_letter')::integer as dead,
        count(*) filter (where status = 'running' and lease_expires_at < now())::integer as expired
      from background_jobs`
    const pending = jobs?.pending ?? 0
    const dead = jobs?.dead ?? 0
    const expired = jobs?.expired ?? 0
    checks.push(dead > 0 || expired > 0
      ? { id: 'background_jobs', status: 'warning', detail: `${pending} active, ${expired} expired leases, ${dead} dead-letter jobs; reconcile before upgrade` }
      : { id: 'background_jobs', status: 'ok', detail: `${pending} active jobs; no expired leases or dead letters` })
  } catch (error) {
    checks.push({ id: 'background_jobs', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [mail] = await database.sql<Array<{ pending: number, dead: number, expired: number }>>`
      select count(*) filter (where status in ('pending', 'sending'))::integer as pending,
        count(*) filter (where status = 'dead_letter')::integer as dead,
        count(*) filter (where status = 'sending' and lease_expires_at < now())::integer as expired
      from outbox_messages where channel = 'mail'`
    const pending = mail?.pending ?? 0
    const dead = mail?.dead ?? 0
    const expired = mail?.expired ?? 0
    checks.push(dead > 0 || expired > 0
      ? { id: 'mail_outbox', status: 'warning', detail: `${pending} active, ${expired} expired leases, ${dead} dead-letter messages; inspect delivery configuration before upgrade` }
      : { id: 'mail_outbox', status: 'ok', detail: `${pending} active messages; no expired leases or dead letters` })
  } catch (error) {
    checks.push({ id: 'mail_outbox', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [backups] = await database.sql<Array<{ active: number, failed: number, latest_ready_at: string | null, latest_database_bytes: string | null, latest_blob_count: string | null, latest_blob_bytes: string | null }>>`
      select count(*) filter (where status in ('queued', 'preparing', 'draining', 'dumping', 'copying', 'verifying', 'deleting'))::integer as active,
        count(*) filter (where status = 'failed')::integer as failed,
        (select completed_at::text from backup_runs where status = 'ready' order by completed_at desc nulls last limit 1) as latest_ready_at,
        (select database_bytes::text from backup_runs where status = 'ready' order by completed_at desc nulls last limit 1) as latest_database_bytes,
        (select blob_count::text from backup_runs where status = 'ready' order by completed_at desc nulls last limit 1) as latest_blob_count,
        (select blob_bytes::text from backup_runs where status = 'ready' order by completed_at desc nulls last limit 1) as latest_blob_bytes
      from backup_runs`
    const active = backups?.active ?? 0
    const failed = backups?.failed ?? 0
    const latest = backups?.latest_ready_at === null || backups?.latest_ready_at === undefined
      ? null : `latest ready ${backups.latest_ready_at}; database ${backups.latest_database_bytes ?? 'unknown'} bytes, ${backups.latest_blob_count ?? 'unknown'} Blobs/${backups.latest_blob_bytes ?? 'unknown'} bytes`
    checks.push(latest === null
      ? { id: 'backup_runs', status: 'warning', detail: `${active} active, ${failed} failed backup runs; no ready unified backup is recorded` }
      : active > 0 || failed > 0
      ? { id: 'backup_runs', status: 'warning', detail: `${active} active, ${failed} failed backup runs; inspect inventory before upgrade` }
      : { id: 'backup_runs', status: 'ok', detail: latest })
  } catch (error) {
    checks.push({ id: 'backup_runs', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [drill] = await database.sql<Array<{ status: string, completed_at: string | null }>>`
      select status, completed_at::text from restore_drills order by completed_at desc nulls last, started_at desc nulls last limit 1`
    if (drill === undefined) checks.push({ id: 'restore_drill', status: 'warning', detail: 'No recorded restore verification drill' })
    else checks.push({ id: 'restore_drill', status: drill.status === 'passed' ? 'ok' : 'warning', detail: `Latest ${drill.status} restore drill completed ${drill.completed_at ?? 'at an unknown time'}` })
  } catch (error) {
    checks.push({ id: 'restore_drill', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [deletions] = await database.sql<Array<{ active: number, purging_without_manifest: number, incomplete_steps: number, completed_without_delivered_ledger: number, delivered_without_completed_case: number, pending_without_ledger_outbox: number, pending_delivery: number }>>`
      select
        count(*) filter (where c.status in ('requested', 'cooling_off', 'scheduled', 'held', 'purging'))::integer as active,
        count(*) filter (where c.status = 'purging' and (c.purge_manifest is null or c.purge_manifest_hash is null))::integer as purging_without_manifest,
        count(*) filter (where c.status = 'completed' and exists (
          select 1 from deletion_case_steps step
          where step.deletion_case_id = c.id and step.state <> 'completed'
        ))::integer as incomplete_steps,
        count(*) filter (where c.status = 'completed' and not exists (
          select 1 from deletion_ledger_outbox outbox where outbox.deletion_case_id = c.id and outbox.status = 'delivered'
        ))::integer as completed_without_delivered_ledger,
        (select count(*)::integer from deletion_ledger_outbox outbox left join account_deletion_cases c2 on c2.id = outbox.deletion_case_id
          where outbox.status = 'delivered' and (c2.id is null or c2.status <> 'completed')) as delivered_without_completed_case,
        (select count(*)::integer from deletion_ledger ledger left join deletion_ledger_outbox outbox on outbox.deletion_case_id = ledger.deletion_case_id
          where outbox.deletion_case_id is null) as pending_without_ledger_outbox,
        (select count(*)::integer from deletion_ledger_outbox where status = 'pending') as pending_delivery
      from account_deletion_cases c`
    const active = deletions?.active ?? 0
    const purgingWithoutManifest = deletions?.purging_without_manifest ?? 0
    const incompleteSteps = deletions?.incomplete_steps ?? 0
    const completedWithoutLedger = deletions?.completed_without_delivered_ledger ?? 0
    const deliveredWithoutCompletedCase = deletions?.delivered_without_completed_case ?? 0
    const pendingWithoutOutbox = deletions?.pending_without_ledger_outbox ?? 0
    const pendingDelivery = deletions?.pending_delivery ?? 0
    if (completedWithoutLedger > 0 || deliveredWithoutCompletedCase > 0 || pendingWithoutOutbox > 0) {
      checks.push({ id: 'deletion_ledger', status: 'blocking', detail: `${completedWithoutLedger} completed cases lack a delivered ledger receipt; ${deliveredWithoutCompletedCase} delivered receipts lack a completed case; ${pendingWithoutOutbox} local ledger entries lack a replay outbox` })
    } else if (purgingWithoutManifest > 0 || incompleteSteps > 0 || pendingDelivery > 0) {
      checks.push({ id: 'deletion_ledger', status: 'warning', detail: `${active} active cases; ${pendingDelivery} pending external ledger deliveries; ${purgingWithoutManifest} purging cases lack a manifest; ${incompleteSteps} completed cases have incomplete steps` })
    } else {
      checks.push({ id: 'deletion_ledger', status: active > 0 ? 'warning' : 'ok', detail: active > 0 ? `${active} active deletion cases; ledger state is internally consistent` : 'No active deletion cases; local ledger state is internally consistent' })
    }
  } catch (error) {
    checks.push({ id: 'deletion_ledger', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [diagnostics] = await database.sql<Array<{ active: number, stale_snapshots: number }>>`
      select count(*) filter (where revoked_at is null and deleted_at is null and expires_at > now())::integer as active,
        count(*) filter (where deleted_at is null and (revoked_at is not null or expires_at <= now()))::integer as stale_snapshots
      from support_diagnostic_grants`
    const active = diagnostics?.active ?? 0
    const stale = diagnostics?.stale_snapshots ?? 0
    checks.push(stale > 0
      ? { id: 'support_diagnostic_grants', status: 'warning', detail: `${active} active grants; ${stale} expired or revoked snapshots await maintenance erasure` }
      : { id: 'support_diagnostic_grants', status: 'ok', detail: `${active} active grants; no stale diagnostic snapshots` })
  } catch (error) {
    checks.push({ id: 'support_diagnostic_grants', status: 'blocking', detail: errorMessage(error) })
  }
  try {
    const [maintenance] = await database.sql<Array<{ mode: string, generation: string, reason: string | null }>>`select mode, generation::text, reason from maintenance_state where id = true`
    if (maintenance === undefined) checks.push({ id: 'maintenance_state', status: 'blocking', detail: 'Maintenance singleton is missing' })
    else checks.push({ id: 'maintenance_state', status: maintenance.mode === 'normal' ? 'ok' : 'warning', detail: `${maintenance.mode} generation ${maintenance.generation}${maintenance.reason === null ? '' : `; ${maintenance.reason}`}` })
  } catch (error) {
    checks.push({ id: 'maintenance_state', status: 'blocking', detail: errorMessage(error) })
  }
}

async function readMigrationSet(): Promise<MigrationSet> {
  const migrationsDir = fileURLToPath(new URL('../../drizzle/', import.meta.url))
  const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ tag: string, when: number }> }
  const files = new Set(await readdir(migrationsDir))
  const missing = journal.entries.filter(entry => !files.has(`${entry.tag}.sql`)).map(entry => entry.tag)
  const entries = await Promise.all(journal.entries.map(async entry => {
    const path = new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url)
    const hash = files.has(`${entry.tag}.sql`) ? createHash('sha256').update(await readFile(path)).digest('hex') : 'missing'
    return { tag: entry.tag, when: String(entry.when), hash }
  }))
  return { count: entries.length, hash: createHash('sha256').update(entries.map(entry => `${entry.tag}\0${entry.hash}`).join('\n')).digest('hex'), missing, entries }
}

function compareMigrationSet(expected: MigrationSet, applied: Array<{ hash: string, created_at: string }>): DoctorCheck {
  if (applied.length < expected.entries.length) {
    const next = expected.entries[applied.length]
    return { id: 'database_migrations', status: 'blocking', detail: `migration_required: ${applied.length}/${expected.entries.length} applied${next === undefined ? '' : `; next ${next.tag}`}` }
  }
  const compatibleTail = applied.slice(-expected.entries.length)
  for (const [index, actual] of compatibleTail.entries()) {
    const entry = expected.entries[index]
    if (entry === undefined || actual.created_at !== entry.when || actual.hash !== entry.hash) {
      return { id: 'database_migrations', status: 'blocking', detail: `schema_drift: migration tail record ${index + 1} does not match local ${entry?.tag ?? 'journal'}` }
    }
  }
  const preserved = applied.length - expected.entries.length
  return { id: 'database_migrations', status: 'ok', detail: `${expected.entries.length} current records match ordered local SQL hashes${preserved > 0 ? `; ${preserved} pre-squash records preserved` : ''}` }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

await main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
