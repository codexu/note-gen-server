if (process.env.MIGRATE_ON_START !== 'false') {
  const { runMigrations } = await import('./database/migrate.js')
  await runMigrations()
}
await import('./server.js')
