import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { DatabaseContext } from './client.js'

interface MigrationEntry { tag: string, when: string, hash: string }

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
  if (applied.length > migrations.entries.length) throw new Error(`binary_too_old: database has ${applied.length} migration records; binary knows ${migrations.entries.length}`)
  for (const [index, actual] of applied.entries()) {
    const expected = migrations.entries[index]
    if (expected === undefined || actual.created_at !== expected.when || actual.hash !== expected.hash) {
      throw new Error(`schema_drift: migration record ${index + 1} does not match local ${expected?.tag ?? 'journal'}`)
    }
  }
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
