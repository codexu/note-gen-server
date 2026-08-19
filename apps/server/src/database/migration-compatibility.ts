import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { DatabaseContext } from './client.js'

interface MigrationEntry { tag: string, when: string, hash: string }

const squashedLegacyTail = {
  when: '1786474800000',
  hash: '7ba6ebc4cbaf43009f3c930cfe1056219e85506bf4d69683c62ba7e874d66ad6',
} as const

// Migration files are part of the immutable binary release. Cache their
// hashes, while still reading the database records for every readiness probe.
let localMigrationSet: Promise<{ missing: string[], entries: MigrationEntry[] }> | undefined

/** Verifies the exact ordered Drizzle records known by this binary before it serves traffic. */
export async function assertMigrationCompatibility(database: DatabaseContext): Promise<void> {
  const migrations = await (localMigrationSet ??= readMigrationSet())
  if (migrations.missing.length > 0) throw new Error(`Migration journal entries missing SQL files: ${migrations.missing.join(', ')}`)
  const applied = await database.sql<Array<{ hash: string, created_at: string }>>`
    select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at asc, id asc`
  if (applied.length < migrations.entries.length) {
    const next = migrations.entries[applied.length]
    throw new Error(`migration_required: ${applied.length}/${migrations.entries.length} applied${next === undefined ? '' : `; next ${next.tag}`}`)
  }
  const compatibleTail = applied.slice(-migrations.entries.length)
  for (const [index, actual] of compatibleTail.entries()) {
    const expected = migrations.entries[index]
    if (expected === undefined || actual.created_at !== expected.when || actual.hash !== expected.hash) {
      throw new Error(`schema_drift: migration tail record ${index + 1} does not match local ${expected?.tag ?? 'journal'}`)
    }
  }
}

/** Records the single squashed baseline for databases that ended on the exact
 * pre-squash migration tail. It preserves the old audit rows and refuses to
 * adopt unknown or partially migrated histories. */
export async function adoptSquashedMigrationBaseline(database: DatabaseContext): Promise<void> {
  const migrations = await (localMigrationSet ??= readMigrationSet())
  if (migrations.missing.length > 0 || migrations.entries.length === 0) return
  const baseline = migrations.entries[0]!
  await database.sql.begin(async (transaction) => {
    const [migrationTable] = await transaction<Array<{ table_name: string | null }>>`
      select to_regclass('drizzle.__drizzle_migrations')::text as table_name`
    // A brand-new database has no migration ledger yet. Drizzle creates both
    // the ledger and schema while applying the first migration below.
    if (migrationTable?.table_name === null) return
    await transaction`lock table drizzle.__drizzle_migrations in exclusive mode`
    const applied = await transaction<Array<{ hash: string, created_at: string }>>`
      select hash, created_at::text as created_at
      from drizzle.__drizzle_migrations order by created_at asc, id asc`
    const tail = applied.at(-1)
    if (tail?.created_at === baseline.when && tail.hash === baseline.hash) return
    if (tail?.created_at !== squashedLegacyTail.when || tail.hash !== squashedLegacyTail.hash) return

    // The legacy tail is necessary but not sufficient: verify representative
    // objects introduced by its final account-service migrations before
    // acknowledging the equivalent squashed baseline.
    await transaction`select runtime_configuration, instance_auth_epoch, auth_epoch_enforced from deployment_settings limit 0`
    await transaction`select local_login, local_password_hash from staff_principals limit 0`
    await transaction`select id, scope_version, deleted_at from support_diagnostic_grants limit 0`
    await transaction`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values (${baseline.hash}, ${baseline.when})`
  })
}

async function readMigrationSet(): Promise<{ missing: string[], entries: MigrationEntry[] }> {
  const migrationsDir = new URL('../../drizzle/', import.meta.url)
  const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ tag: string, when: number }> }
  const files = new Set(await readdir(migrationsDir))
  const missing = journal.entries.filter(entry => !files.has(`${entry.tag}.sql`)).map(entry => entry.tag)
  const entries = await Promise.all(journal.entries.map(async entry => {
    const path = new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url)
    const hash = files.has(`${entry.tag}.sql`) ? createHash('sha256').update(await readFile(path)).digest('hex') : 'missing'
    return { tag: entry.tag, when: String(entry.when), hash }
  }))
  return { missing, entries }
}
