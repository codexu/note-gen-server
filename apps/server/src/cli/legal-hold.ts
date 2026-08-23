import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'
import { LegalHoldService } from '../compliance/legal-hold-service.js'
import { AccountServiceAudit } from '../audit/service.js'
import { StaffService } from '../staff/service.js'

function usage(): never {
  throw new Error('Usage: legal-hold place <account-id> --actor=<admin-id> --reason=<code> --confirm=PLACE_LEGAL_HOLD | release <hold-id> --actor=<admin-id> --reason=<code> --confirm=RELEASE_LEGAL_HOLD')
}

async function main(): Promise<void> {
  const [command, target, ...args] = process.argv.slice(2)
  if ((command !== 'place' && command !== 'release') || target === undefined) usage()
  const options = new Map(args.map(value => {
    const match = /^--([^=]+)=(.+)$/.exec(value)
    if (match === null) usage()
    return [match[1]!, match[2]!] as const
  }))
  const actor = options.get('actor')
  const reason = options.get('reason')
  const expectedConfirmation = command === 'place' ? 'PLACE_LEGAL_HOLD' : 'RELEASE_LEGAL_HOLD'
  if (!actor || !reason || options.get('confirm') !== expectedConfirmation) usage()
  const config = loadConfig()
  const database = createDatabase({ ...config, databasePoolSize: 1 })
  try {
    const holds = new LegalHoldService(
      database,
      config,
      new StaffService(database),
      new AccountServiceAudit(database),
    )
    if (command === 'place') process.stdout.write(`${JSON.stringify(await holds.place(target, actor, reason))}\n`)
    else {
      await holds.release(target, actor, reason)
      process.stdout.write('{"released":true}\n')
    }
  } finally {
    await database.close()
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
