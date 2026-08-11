import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'
import { DeploymentService } from '../deployment/service.js'
import { BootstrapService } from '../bootstrap/service.js'

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const config = loadConfig()
  const database = createDatabase(config)
  try {
    const deployment = new DeploymentService(database, config)
    await deployment.initialize()
    const bootstrap = new BootstrapService(database, config, deployment)
    await bootstrap.initialize()
    if (command === 'status') {
      const state = deployment.getState()
      process.stdout.write(`${JSON.stringify({
        setupRequired: deployment.canBootstrapAdministrator(), deploymentMode: state.deploymentMode,
        lifecycle: state.selfHostedLifecycle, registrationPolicy: state.registrationPolicy, adminRepairRequired: state.adminRepairRequired,
      })}\n`)
      return
    }
    if (command === 'issue-web-token') {
      const ttl = parseTtl(args.find((value) => value.startsWith('--ttl='))?.slice('--ttl='.length))
      const issued = await bootstrap.issueWebToken(ttl)
      process.stdout.write(`${JSON.stringify({ token: issued.token, expiresAt: issued.expiresAt.toISOString() })}\n`)
      return
    }
    if (command === 'repair-admin') {
      const login = args.find((value) => value.startsWith('--login='))?.slice('--login='.length)
      if (login === undefined || login.trim().length === 0 || !args.includes('--password-stdin') || !args.includes('--confirm=REPAIR_ADMIN')) {
        throw new Error('Usage: setup repair-admin --login=<login> --password-stdin --confirm=REPAIR_ADMIN')
      }
      const password = (await readStdin()).trimEnd()
      if (password.length < 8) throw new Error('Password from stdin must contain at least 8 characters')
      const repaired = await bootstrap.repairAdministrator(login, password)
      process.stdout.write(`${JSON.stringify({ account: repaired })}\n`)
      return
    }
    throw new Error('Usage: setup status | setup issue-web-token [--ttl=30m] | setup repair-admin --login=<login> --password-stdin --confirm=REPAIR_ADMIN')
  } finally {
    await database.close()
  }
}

async function readStdin(): Promise<string> {
  let result = ''
  for await (const chunk of process.stdin) result += String(chunk)
  return result
}

function parseTtl(value: string | undefined): number {
  if (value === undefined) return 30 * 60
  const match = /^(\d+)(m|h)$/.exec(value)
  if (match === null) throw new Error('TTL must use whole minutes or hours, for example 30m or 1h')
  const amount = Number(match[1])
  return amount * (match[2] === 'h' ? 3600 : 60)
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
