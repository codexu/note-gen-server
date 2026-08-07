import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { createDatabase } from './client.js'

export async function runMigrations(): Promise<void> {
  const config = loadConfig()
  const database = createDatabase({ ...config, databasePoolSize: 1 })
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    })
  } finally {
    await database.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runMigrations()
