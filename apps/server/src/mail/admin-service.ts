import { createHmac, randomUUID } from 'node:crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { accounts, adminAuditLogs, outboxMessages } from '../database/schema.js'
import { ApiError } from '../errors.js'
import { normalizeEmail } from '../identity/email-service.js'
import type { MailOutboxService } from './outbox-service.js'
import type { MailSecretPayloadService } from './secret-payload-service.js'
import type { MailProvider, MailProviderHealth } from './provider.js'

/** Self-hosted operator view. It exposes queue aggregates only; recipients,
 * plaintext bodies, action links, SMTP credentials and provider responses do
 * not cross this boundary. */
export class MailAdminService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly outbox: MailOutboxService,
    private readonly secrets: MailSecretPayloadService,
    private readonly provider: MailProvider,
  ) {}

  async getStatus(actorAccountId: string): Promise<{ configured: boolean, health: 'disabled' | 'configured_unknown', queue: Record<string, number> }> {
    await this.assertAdmin(actorAccountId)
    const rows = await this.database.sql<Array<{ status: string, count: number }>>`
      select status::text as status, count(*)::int as count from outbox_messages
      where channel = 'mail' group by status`
    const queue = Object.fromEntries(rows.map(row => [row.status, row.count]))
    const configured = this.config.deploymentMode === 'self-hosted' && this.config.mailDriver === 'smtp'
    return { configured, health: configured ? 'configured_unknown' : 'disabled', queue }
  }

  async enqueueTest(actorAccountId: string, recipient: string): Promise<{ id: string, created: true }> {
    await this.assertAdmin(actorAccountId)
    if (this.config.deploymentMode !== 'self-hosted' || this.config.mailDriver !== 'smtp') {
      throw new ApiError({ code: 'smtp_not_configured', message: 'SMTP delivery is not configured', statusCode: 409 })
    }
    const to = normalizeEmail(recipient)
    const idempotencyKey = `smtp-test:${randomUUID()}`
    return await this.database.db.transaction(async (tx) => {
      const secretPayloadRef = await this.secrets.createInTransaction(tx, {
        idempotencyKey, to, template: 'security-notice', locale: this.config.mailDefaultLocale, variables: {},
      }, new Date(Date.now() + 15 * 60 * 1_000))
      const created = await this.outbox.enqueueInTransaction(tx, {
        template: 'security-notice', recipientRef: this.recipientRef(to), payload: { kind: 'smtp-test' }, secretPayloadRef,
        requestHash: createHmac('sha256', this.config.authSecret).update(`smtp-test:v1:${idempotencyKey}`).digest('base64url'), idempotencyKey,
      })
      await tx.insert(adminAuditLogs).values({
        actorAccountId, action: 'mail.test.enqueue', targetType: 'mail-outbox', targetId: created.id,
        metadata: { recipientDigest: this.recipientRef(to), template: 'security-notice' },
      })
      return { id: created.id, created: true as const }
    })
  }

  async listQueue(actorAccountId: string, input: { status?: 'pending' | 'sending' | 'sent' | 'dead_letter' | 'delivery_unknown', limit: number }): Promise<Array<{ id: string, template: string, status: string, attempts: number, maxAttempts: number, errorCode: string | null, createdAt: Date, nextAttemptAt: Date }>> {
    await this.assertAdmin(actorAccountId)
    const rows = await this.database.db.select({
      id: outboxMessages.id, template: outboxMessages.templateOrEvent, status: outboxMessages.status,
      attempts: outboxMessages.attempts, maxAttempts: outboxMessages.maxAttempts, errorCode: outboxMessages.lastErrorCode,
      createdAt: outboxMessages.createdAt, nextAttemptAt: outboxMessages.nextAttemptAt,
    }).from(outboxMessages).where(and(eq(outboxMessages.channel, 'mail'), ...(input.status === undefined ? [] : [eq(outboxMessages.status, input.status)])))
      .orderBy(asc(outboxMessages.nextAttemptAt), asc(outboxMessages.createdAt)).limit(input.limit)
    return rows
  }

  /** Only pending work can be cancelled. A sending SMTP request may already
   * have reached the provider, so changing it would falsely claim non-delivery. */
  async cancelPending(actorAccountId: string, outboxId: string): Promise<void> {
    await this.assertAdmin(actorAccountId)
    const secretPayloadRef = await this.database.db.transaction(async (tx) => {
      const [message] = await tx.select({ status: outboxMessages.status, secretPayloadRef: outboxMessages.secretPayloadRef })
        .from(outboxMessages).where(and(eq(outboxMessages.id, outboxId), eq(outboxMessages.channel, 'mail'))).limit(1).for('update')
      if (message === undefined) throw new ApiError({ code: 'mail_queue_entry_not_found', message: 'Mail queue entry was not found', statusCode: 404 })
      if (message.status !== 'pending') throw new ApiError({ code: 'mail_queue_cancel_unavailable', message: 'Only pending mail can be cancelled', statusCode: 409 })
      await tx.update(outboxMessages).set({ status: 'dead_letter', lastErrorCode: 'admin_cancelled', lockedAt: null, lockedBy: null, leaseExpiresAt: null })
        .where(and(eq(outboxMessages.id, outboxId), eq(outboxMessages.status, 'pending')))
      await tx.insert(adminAuditLogs).values({ actorAccountId, action: 'mail.queue.cancel', targetType: 'mail-outbox', targetId: outboxId, metadata: { previousStatus: 'pending' } })
      return message.secretPayloadRef
    })
    if (secretPayloadRef !== null) await this.secrets.erase(secretPayloadRef)
  }

  async probe(actorAccountId: string): Promise<MailProviderHealth & { checkedAt: Date }> {
    await this.assertAdmin(actorAccountId)
    if (this.config.deploymentMode !== 'self-hosted' || this.config.mailDriver !== 'smtp') {
      throw new ApiError({ code: 'smtp_not_configured', message: 'SMTP delivery is not configured', statusCode: 409 })
    }
    const result = await this.provider.probe()
    const checkedAt = new Date()
    await this.database.db.insert(adminAuditLogs).values({
      actorAccountId, action: 'mail.health.probe', targetType: 'smtp', targetId: null, metadata: { status: result.status },
    })
    return { ...result, checkedAt }
  }

  private async assertAdmin(accountId: string): Promise<void> {
    const [account] = await this.database.db.select({ id: accounts.id }).from(accounts).where(and(
      eq(accounts.id, accountId), eq(accounts.isAdmin, true), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
    )).limit(1)
    if (account === undefined) throw new ApiError({ code: 'admin_required', message: 'Administrator access is required', statusCode: 403 })
  }

  private recipientRef(email: string): string {
    return createHmac('sha256', this.config.authSecret).update(`mail-recipient:v1:${email}`).digest('base64url')
  }
}
