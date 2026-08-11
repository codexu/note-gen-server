import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'
import { CapabilityRegistry } from '../deployment/capabilities.js'
import { DeploymentService } from '../deployment/service.js'
import { EmailIdentityService } from '../identity/email-service.js'
import { MailOutboxService } from '../mail/outbox-service.js'
import { MailSecretPayloadService } from '../mail/secret-payload-service.js'

async function main(): Promise<void> {
  const [command, accountId, confirmation] = process.argv.slice(2)
  if (accountId === undefined || (command !== 'issue-verification-token' && command !== 'issue-password-reset-token')
    || confirmation !== '--confirm=ISSUE_INTERNAL_EMAIL_TOKEN') {
    throw new Error('Usage: email:test <issue-verification-token|issue-password-reset-token> <account-id> --confirm=ISSUE_INTERNAL_EMAIL_TOKEN')
  }
  const config = loadConfig()
  const database = createDatabase({ ...config, databasePoolSize: 1 })
  try {
    const deployment = new DeploymentService(database, config)
    await deployment.initialize()
    if (deployment.getSafetyFailure() !== undefined) throw new Error(`Deployment safety gate is closed: ${deployment.getSafetyFailure()}`)
    const capabilities = new CapabilityRegistry(config, deployment).resolvePublic()
    const service = new EmailIdentityService(
      database, config, new MailOutboxService(database), new MailSecretPayloadService(database, config.authSecret),
      {
        emailVerification: capabilities['identity.emailVerification'],
        passwordReset: capabilities['identity.passwordReset'],
      },
    )
    const issued = command === 'issue-verification-token'
      ? await service.issueInternalTestVerificationToken(accountId)
      : await service.issueInternalTestPasswordResetToken(accountId)
    process.stdout.write(`${JSON.stringify({ token: issued.token, expiresAt: issued.expiresAt.toISOString() })}\n`)
  } finally {
    await database.close()
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
