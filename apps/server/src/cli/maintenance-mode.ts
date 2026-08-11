import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'
import { MaintenanceCoordinator, type MaintenanceMode } from '../maintenance/coordinator.js'

function usage(): never {
  throw new Error('Usage: maintenance:mode status | enable --mode read_only|write_drain --reason <text> --confirm ENABLE_MAINTENANCE | enable --mode offline --reason <text> --confirm ENABLE_OFFLINE_MAINTENANCE | disable --confirm DISABLE_MAINTENANCE')
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2)
  const config = loadConfig()
  const database = createDatabase({ ...config, databasePoolSize: 1 })
  try {
    const coordinator = new MaintenanceCoordinator(database)
    let state: Awaited<ReturnType<MaintenanceCoordinator['getSnapshot']>>
    if (command === 'status' && arguments_.length === 0) state = await coordinator.getSnapshot()
    else if (command === 'enable') {
      const options = flags(arguments_)
      const mode = options.get('mode')
      if (mode !== 'read_only' && mode !== 'write_drain' && mode !== 'offline') usage()
      if (options.get('confirm') !== (mode === 'offline' ? 'ENABLE_OFFLINE_MAINTENANCE' : 'ENABLE_MAINTENANCE')) usage()
      state = await coordinator.enable(mode as Exclude<MaintenanceMode, 'normal'>, required(options, 'reason'))
    } else if (command === 'disable') {
      const options = flags(arguments_)
      if (options.get('confirm') !== 'DISABLE_MAINTENANCE') usage()
      state = await coordinator.disable()
    } else usage()
    process.stdout.write(`${JSON.stringify(state)}\n`)
  } finally {
    await database.close()
  }
}

function flags(values: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--') || result.has(key.slice(2))) usage()
    result.set(key.slice(2), value)
  }
  return result
}

function required(options: Map<string, string>, key: string): string { return options.get(key) ?? usage() }

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
