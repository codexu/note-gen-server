import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres, { type Sql } from 'postgres'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/database/client.js'
import { runMigrations } from '../src/database/migrate.js'

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

interface MigrationJournal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

const accountId = '10000000-0000-4000-8000-000000000001'
const accountWorkspaceId = '20000000-0000-4000-8000-000000000001'
const libraryWorkspaceId = '20000000-0000-4000-8000-000000000002'
const settingObjectId = '30000000-0000-4000-8000-000000000001'
const noteObjectId = '30000000-0000-4000-8000-000000000002'

const migrationsDirectory = fileURLToPath(new URL('../drizzle/', import.meta.url))
const journalPath = fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url))

async function main(): Promise<void> {
  const originalDatabaseUrl = process.env.DATABASE_URL
  if (originalDatabaseUrl === undefined) throw new Error('DATABASE_URL is required')

  const targetUrl = createTargetDatabaseUrl(originalDatabaseUrl)
  const targetDatabaseName = decodeURIComponent(targetUrl.pathname.slice(1))
  const admin = postgres(originalDatabaseUrl, { max: 1, prepare: false })
  const temporaryMigrations = await mkdtemp(join(tmpdir(), 'notegen-previous-migrations-'))

  try {
    await recreateDatabase(admin, targetDatabaseName)
    const previousMigrationCount = await preparePreviousMigrations(temporaryMigrations)
    await migratePreviousDatabase(targetUrl.toString(), temporaryMigrations)
    await seedRepresentativeData(targetUrl.toString())

    process.env.DATABASE_URL = targetUrl.toString()
    await runMigrations()
    await verifyUpgrade(previousMigrationCount)

    console.log(`Migration upgrade test passed: ${previousMigrationCount} previous migrations upgraded without losing representative data.`)
  } finally {
    process.env.DATABASE_URL = originalDatabaseUrl
    await recreateDatabase(admin, targetDatabaseName, false)
    await admin.end({ timeout: 5 })
    await rm(temporaryMigrations, { recursive: true, force: true })
  }
}

function createTargetDatabaseUrl(databaseUrl: string): URL {
  const target = new URL(databaseUrl)
  const sourceDatabaseName = decodeURIComponent(target.pathname.slice(1))
  if (!/^[A-Za-z0-9_-]+$/.test(sourceDatabaseName)) throw new Error('DATABASE_URL database name contains unsupported characters')
  target.pathname = `/${sourceDatabaseName}_migration_upgrade_test`
  return target
}

async function recreateDatabase(admin: Sql, databaseName: string, create = true): Promise<void> {
  if (!/^[A-Za-z0-9_-]+_migration_upgrade_test$/.test(databaseName)) {
    throw new Error(`Refusing to manage non-test database: ${databaseName}`)
  }
  const identifier = `"${databaseName.replaceAll('"', '""')}"`
  await admin.unsafe(`drop database if exists ${identifier} with (force)`)
  if (create) await admin.unsafe(`create database ${identifier}`)
}

async function preparePreviousMigrations(targetDirectory: string): Promise<number> {
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as MigrationJournal
  if (journal.entries.length < 2) throw new Error('At least two migrations are required for an upgrade test')

  const previousEntries = journal.entries.slice(0, -1)
  const metaDirectory = join(targetDirectory, 'meta')
  await mkdir(metaDirectory)
  await writeFile(join(metaDirectory, '_journal.json'), `${JSON.stringify({ ...journal, entries: previousEntries }, null, 2)}\n`)
  await Promise.all(previousEntries.map(entry => copyFile(
    join(migrationsDirectory, `${entry.tag}.sql`),
    join(targetDirectory, `${entry.tag}.sql`),
  )))
  return previousEntries.length
}

async function migratePreviousDatabase(databaseUrl: string, migrationsFolder: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false })
  try {
    await migrate(drizzle(sql), { migrationsFolder })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function seedRepresentativeData(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false })
  try {
    await sql.begin(async transaction => {
      await transaction`
        insert into accounts (id, login, password_hash)
        values (${accountId}, 'migration-upgrade-user', 'migration-upgrade-password-hash')`
      await transaction`
        insert into workspaces (id, account_id, name_ciphertext, is_default, workspace_type)
        values
          (${accountWorkspaceId}, ${accountId}, 'encrypted-account-workspace', true, 'account-data'),
          (${libraryWorkspaceId}, ${accountId}, 'encrypted-library-workspace', false, 'library')`
      await transaction`
        insert into workspace_keys (workspace_id, key_version)
        values (${accountWorkspaceId}, 1), (${libraryWorkspaceId}, 1)`
      await transaction`
        insert into objects (
          workspace_id, object_id, kind, current_revision, ciphertext,
          ciphertext_hash, key_version
        ) values
          (${accountWorkspaceId}, ${settingObjectId}, 'setting', 1, 'encrypted-setting', 'setting-hash', 1),
          (${libraryWorkspaceId}, ${noteObjectId}, 'note', 1, 'encrypted-note', 'note-hash', 1)`
    })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function verifyUpgrade(previousMigrationCount: number): Promise<void> {
  const database = createDatabase({ ...loadConfig(), databasePoolSize: 1 })
  try {
    await database.check()

    const [migrationCount] = await database.sql<Array<{ count: number }>>`
      select count(*)::int as count from drizzle.__drizzle_migrations`
    if (migrationCount?.count !== previousMigrationCount + 1) {
      throw new Error(`Expected ${previousMigrationCount + 1} applied migrations, found ${migrationCount?.count ?? 0}`)
    }

    const [account] = await database.sql<Array<{ login: string, password_hash: string }>>`
      select login, password_hash from accounts where id = ${accountId}`
    if (account?.login !== 'migration-upgrade-user' || account?.password_hash !== 'migration-upgrade-password-hash') {
      throw new Error('Representative account data changed or disappeared during migration')
    }

    const workspaces = await database.sql<Array<{ id: string, workspace_type: string, name_ciphertext: string }>>`
      select id::text, workspace_type::text, name_ciphertext
      from workspaces where id in (${accountWorkspaceId}, ${libraryWorkspaceId}) order by id`
    const expectedWorkspaces = [
      { id: accountWorkspaceId, workspace_type: 'account-data', name_ciphertext: 'encrypted-account-workspace' },
      { id: libraryWorkspaceId, workspace_type: 'library', name_ciphertext: 'encrypted-library-workspace' },
    ]
    if (JSON.stringify(workspaces) !== JSON.stringify(expectedWorkspaces)) {
      throw new Error('Representative workspace data changed or disappeared during migration')
    }

    const objects = await database.sql<Array<{ object_id: string, kind: string, ciphertext_hash: string }>>`
      select object_id::text, kind::text, ciphertext_hash
      from objects where object_id in (${settingObjectId}, ${noteObjectId}) order by object_id`
    const expectedObjects = [
      { object_id: settingObjectId, kind: 'setting', ciphertext_hash: 'setting-hash' },
      { object_id: noteObjectId, kind: 'note', ciphertext_hash: 'note-hash' },
    ]
    if (JSON.stringify(objects) !== JSON.stringify(expectedObjects)) {
      throw new Error('Representative encrypted objects changed or disappeared during migration')
    }
  } finally {
    await database.close()
  }
}

await main()
