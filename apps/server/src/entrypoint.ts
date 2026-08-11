import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const environmentPath = resolve(fileURLToPath(new URL('../../../.env', import.meta.url)))
if (existsSync(environmentPath)) process.loadEnvFile(environmentPath)

if (process.env.MIGRATE_ON_START !== 'false') {
  const { runMigrations } = await import('./database/migrate.js')
  await runMigrations()
}
await import('./server.js')
