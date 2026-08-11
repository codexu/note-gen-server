import { and, eq, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { outboxMessages } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { MailMessage, MailProvider } from './provider.js'
import { MailProviderError } from './provider.js'

export interface EnqueueMailInput {
  template: string
  recipientRef: string
  payload: Record<string, unknown>
  secretPayloadRef: string
  requestHash: string
  idempotencyKey: string
}

export interface ClaimedMailOutbox {
  id: string
  template: string
  recipientRef: string
  payload: Record<string, unknown>
  secretPayloadRef: string | null
  idempotencyKey: string
  attempts: number
  maxAttempts: number
}

/** Secrets live behind a separate keyring; this boundary prevents accidental JSON persistence. */
export interface MailSecretPayloadResolver {
  resolve(ref: string): Promise<MailMessage | null>
  erase(ref: string): Promise<void>
}

/** Durable at-least-once mail delivery coordination with expiring worker leases. */
export class MailOutboxService {
  constructor(private readonly database: DatabaseContext) {}

  async enqueue(input: EnqueueMailInput): Promise<{ id: string, created: boolean }> {
    return await this.database.db.transaction(async (tx) => {
      return await this.enqueueInTransaction(tx, input)
    })
  }

  /** Lets a business transaction atomically create its bearer token, encrypted
   * body and durable delivery intent. */
  async enqueueInTransaction(tx: any, input: EnqueueMailInput): Promise<{ id: string, created: boolean }> {
    const [existing] = await tx.select({ id: outboxMessages.id, requestHash: outboxMessages.requestHash })
      .from(outboxMessages).where(and(eq(outboxMessages.channel, 'mail'), eq(outboxMessages.idempotencyKey, input.idempotencyKey))).limit(1)
    if (existing !== undefined) {
      if (existing.requestHash !== input.requestHash) throw new ApiError({ code: 'idempotency_conflict', message: 'Mail idempotency key was reused with different input', statusCode: 409 })
      return { id: existing.id, created: false }
    }
    const [created] = await tx.insert(outboxMessages).values({
      channel: 'mail', templateOrEvent: input.template, recipientRef: input.recipientRef, payload: input.payload,
      payloadVersion: 1, secretPayloadRef: input.secretPayloadRef, requestHash: input.requestHash, idempotencyKey: input.idempotencyKey,
    }).returning({ id: outboxMessages.id })
    if (created === undefined) throw new Error('Mail outbox insert returned no row')
    return { id: created.id, created: true }
  }

  /** A delivery worker must explicitly opt into the templates it understands. */
  async claim(workerId: string, templates: readonly string[], leaseSeconds = 60, secrets?: MailSecretPayloadResolver): Promise<ClaimedMailOutbox | undefined> {
    if (templates.length === 0) return undefined
    // A process can die after incrementing attempts but before it reports a
    // result. Expired final leases must become terminal rather than being
    // reclaimed forever by every later worker.
    const expiredFinal = await this.database.db.update(outboxMessages).set({
      status: 'dead_letter', lastErrorCode: 'lease_expired_max_attempts', lockedAt: null, lockedBy: null, leaseExpiresAt: null,
    }).where(and(
      sql`${outboxMessages.attempts} >= ${outboxMessages.maxAttempts}`,
      sql`(( ${outboxMessages.status} = 'sending' and ${outboxMessages.leaseExpiresAt} < now()) or ${outboxMessages.status} = 'pending')`,
    )).returning({ secretPayloadRef: outboxMessages.secretPayloadRef })
    if (secrets !== undefined) {
      for (const item of expiredFinal) if (item.secretPayloadRef !== null) await secrets.erase(item.secretPayloadRef)
    }
    const allowedTemplates = this.database.sql.array([...new Set(templates)], 'text')
    const rows = await this.database.sql<Array<ClaimedMailOutbox>>`
      with candidate as (
        select id from outbox_messages
        where channel = 'mail' and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'sending' and lease_expires_at < now())
        ) and attempts < max_attempts and template_or_event = any(${allowedTemplates})
        order by next_attempt_at asc, created_at asc
        for update skip locked
        limit 1
      )
      update outbox_messages message
      set status = 'sending', locked_at = now(), locked_by = ${workerId},
          lease_expires_at = now() + (${Math.max(1, leaseSeconds)} * interval '1 second'), attempts = message.attempts + 1
      from candidate
      where message.id = candidate.id
      returning message.id, message.template_or_event as template, message.recipient_ref as "recipientRef",
        message.payload, message.secret_payload_ref as "secretPayloadRef", message.idempotency_key as "idempotencyKey", message.attempts,
        message.max_attempts as "maxAttempts"`
    return rows[0]
  }

  async deliver(claim: ClaimedMailOutbox, workerId: string, provider: MailProvider, secrets: MailSecretPayloadResolver): Promise<boolean> {
    if (claim.secretPayloadRef === null) return await this.fail(claim, workerId, 'secret_payload_missing', false)
    const message = await secrets.resolve(claim.secretPayloadRef)
    // A missing, expired, malformed or undecryptable envelope is terminal.
    // It must not remain as recoverable ciphertext after the outbox has been
    // dead-lettered, nor be retried if a later deployment changes key state.
    if (message === null) return await this.discard(claim, workerId, 'secret_payload_unavailable', secrets)
    try {
      const delivered = await provider.send(message)
      const changed = await this.database.db.update(outboxMessages).set({
        status: 'sent', providerMessageId: delivered.providerMessageId, sentAt: new Date(), lockedAt: null, lockedBy: null, leaseExpiresAt: null,
      }).where(and(eq(outboxMessages.id, claim.id), eq(outboxMessages.status, 'sending'), eq(outboxMessages.lockedBy, workerId))).returning({ id: outboxMessages.id })
      if (changed.length === 1) await secrets.erase(claim.secretPayloadRef)
      return changed.length === 1
    } catch (error) {
      const retryable = error instanceof MailProviderError ? error.retryable : true
      const code = error instanceof MailProviderError ? error.code : 'provider_failure'
      const terminal = !retryable || claim.attempts >= claim.maxAttempts
      const changed = await this.fail(claim, workerId, code, retryable)
      if (changed && terminal) await secrets.erase(claim.secretPayloadRef)
      return changed
    }
  }

  /** Terminalize work that became invalid while it waited in the queue (for
   * example, a verification/reset token that was revoked by a resend). */
  async discard(claim: ClaimedMailOutbox, workerId: string, code: string, secrets?: MailSecretPayloadResolver): Promise<boolean> {
    const changed = await this.database.db.update(outboxMessages).set({
      status: 'dead_letter', lastErrorCode: code, lockedAt: null, lockedBy: null, leaseExpiresAt: null,
    }).where(and(eq(outboxMessages.id, claim.id), eq(outboxMessages.status, 'sending'), eq(outboxMessages.lockedBy, workerId)))
      .returning({ id: outboxMessages.id })
    if (changed.length === 1 && claim.secretPayloadRef !== null && secrets !== undefined) await secrets.erase(claim.secretPayloadRef)
    return changed.length === 1
  }

  private async fail(claim: ClaimedMailOutbox, workerId: string, code: string, retryable: boolean): Promise<boolean> {
    const delaySeconds = Math.min(3_600, 2 ** Math.min(claim.attempts, 10))
    const terminal = !retryable || claim.attempts >= claim.maxAttempts
    const changed = await this.database.db.update(outboxMessages).set({
      status: terminal ? 'dead_letter' : 'pending', lastErrorCode: code, lockedAt: null, lockedBy: null, leaseExpiresAt: null,
      nextAttemptAt: sql`now() + (${delaySeconds} * interval '1 second')`,
    }).where(and(eq(outboxMessages.id, claim.id), eq(outboxMessages.status, 'sending'), eq(outboxMessages.lockedBy, workerId))).returning({ id: outboxMessages.id })
    return changed.length === 1
  }
}
