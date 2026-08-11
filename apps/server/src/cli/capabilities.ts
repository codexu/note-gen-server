import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'
import { CapabilityRegistry, capabilityIds } from '../deployment/capabilities.js'
import { DeploymentService } from '../deployment/service.js'

async function main(): Promise<void> {
  const [command, id, ...extra] = process.argv.slice(2)
  if (command !== 'explain' || id === undefined || extra.length !== 0 || !capabilityIds.includes(id as typeof capabilityIds[number])) {
    throw new Error(`Usage: capabilities explain <${capabilityIds.join('|')}>`)
  }
  const config = loadConfig()
  const database = createDatabase({ ...config, databasePoolSize: 1 })
  try {
    const deployment = new DeploymentService(database, config)
    // Diagnostics must never create or reconcile deployment facts. A missing
    // singleton is itself an operator-visible failure, not an invitation to
    // mutate a potentially restored or partially migrated database.
    await deployment.reload()
    const registry = new CapabilityRegistry(config, deployment)
    process.stdout.write(`${JSON.stringify(registry.explain(id))}\n`)
  } finally {
    await database.close()
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
