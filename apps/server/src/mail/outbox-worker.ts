import { randomUUID } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accountActionTokens, registrationInvitations } from '../database/schema.js'
import type { MailOutboxService, ClaimedMailOutbox, MailSecretPayloadResolver } from './outbox-service.js'
import type { MailProvider, MailTemplateId } from './provider.js'
import type { MaintenanceCoordinator } from '../maintenance/coordinator.js'

interface Logger { error(bindings: Record<string, unknown>, message: string): void }

const supportedTemplates: readonly MailTemplateId[] = [
  'verify-email', 'reset-password', 'change-email', 'invitation', 'security-notice', 'support-notice',
]

/**
 * Lease-based runner shared by the internal log sink and self-hosted SMTP
 * adapter. It has no provider-specific side effects: a bearer-token message
 * is checked at send time, so resends/revocations cannot revive an old link.
 */
export class MailOutboxWorker {
  #timer: NodeJS.Timeout | undefined
  #running = false
  readonly workerId = `mail-${randomUUID()}`

  constructor(
    private readonly database: DatabaseContext,
    private readonly outbox: MailOutboxService,
    private readonly provider: MailProvider,
    private readonly secrets: MailSecretPayloadResolver,
    private readonly logger: Logger = console,
    private readonly maintenance?: MaintenanceCoordinator,
  ) {}

  start(intervalMs = 5_000): () => void {
    if (this.#timer !== undefined) return () => this.stop()
    void this.runOnce().catch(error => this.logError(error))
    this.#timer = setInterval(() => void this.runOnce().catch(error => this.logError(error)), intervalMs)
    this.#timer.unref()
    return () => this.stop()
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async runOnce(): Promise<boolean> {
    if (this.#running) return false
    this.#running = true
    try {
      if (!this.provider.isConfigured()) return false
      // Delivery is an external side effect. During read_only/write_drain an
      // operator must be able to freeze it before an upgrade or restore; the
      // durable row remains pending and resumes after normal mode returns.
      if (this.maintenance !== undefined && (await this.maintenance.getSnapshot()).mode !== 'normal') return false
      const claim = await this.outbox.claim(this.workerId, supportedTemplates, 60, this.secrets)
      if (claim === undefined) return false
      if (!await this.isStillDeliverable(claim)) {
        await this.outbox.discard(claim, this.workerId, 'action_token_no_longer_valid', this.secrets)
        return true
      }
      await this.outbox.deliver(claim, this.workerId, this.provider, this.secrets)
      return true
    } finally {
      this.#running = false
    }
  }

  private async isStillDeliverable(claim: ClaimedMailOutbox): Promise<boolean> {
    if (claim.template === 'invitation') {
      const invitationId = claim.payload.invitationId
      if (typeof invitationId !== 'string') return false
      const [invitation] = await this.database.db.select({ id: registrationInvitations.id }).from(registrationInvitations).where(and(
        eq(registrationInvitations.id, invitationId), isNull(registrationInvitations.revokedAt),
        gt(registrationInvitations.expiresAt, new Date()),
        sql`${registrationInvitations.useCount} < ${registrationInvitations.maxUses}`,
      )).limit(1)
      return invitation !== undefined
    }
    const actionTokenId = claim.payload.actionTokenId
    if (actionTokenId === undefined) return true
    if (typeof actionTokenId !== 'string') return false
    const [token] = await this.database.db.select({ id: accountActionTokens.id }).from(accountActionTokens).where(and(
      eq(accountActionTokens.id, actionTokenId), isNull(accountActionTokens.consumedAt), isNull(accountActionTokens.revokedAt),
      gt(accountActionTokens.expiresAt, new Date()),
    )).limit(1)
    return token !== undefined
  }

  private logError(error: unknown): void {
    this.logger.error({ err: error, workerId: this.workerId }, 'Mail outbox worker iteration failed')
  }
}
