import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { accountIdentities, accountLoginClaims, accounts, adminAuditLogs, outboxMessages, registrationInvitationUses, registrationInvitations } from '../database/schema.js'
import type { DeploymentService } from '../deployment/service.js'
import { ApiError } from '../errors.js'
import { normalizeEmail } from '../identity/email-service.js'
import { normalizeLoginKey } from '../identity/service.js'
import type { MailOutboxService } from '../mail/outbox-service.js'
import type { MailSecretPayloadService } from '../mail/secret-payload-service.js'

export class InvitationService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly deployment: DeploymentService,
    private readonly mail?: { outbox: MailOutboxService, secrets: MailSecretPayloadService, deliveryAvailable: boolean | (() => boolean) },
  ) {}

  async create(actorAccountId: string, input: { expiresAt: Date, maxUses?: number, note?: string, boundEmail?: string, send?: boolean }): Promise<{ id: string, token: string, url: string, expiresAt: Date, deliveryQueued: boolean }> {
    await this.assertAdmin(actorAccountId)
    if (this.deployment.getState().registrationPolicy !== 'invitation') {
      throw new ApiError({ code: 'registration_closed', message: 'Invitation registration is not enabled', statusCode: 409 })
    }
    const maxUses = input.maxUses ?? 1
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000 || input.expiresAt.getTime() <= Date.now() || input.expiresAt.getTime() > Date.now() + 90 * 24 * 60 * 60 * 1_000) {
      throw new ApiError({ code: 'invitation_invalid', message: 'Invitation expiration or usage limit is invalid', statusCode: 400 })
    }
    const boundEmail = input.boundEmail === undefined || input.boundEmail.trim().length === 0
      ? undefined : normalizeEmail(input.boundEmail)
    if (boundEmail !== undefined && maxUses !== 1) {
      throw new ApiError({ code: 'invitation_invalid', message: 'A bound email invitation must have one use', statusCode: 400 })
    }
    if (input.send === true && boundEmail === undefined) {
      throw new ApiError({ code: 'invitation_invalid', message: 'A delivery request requires a bound email', statusCode: 400 })
    }
    if (input.send === true && !this.deliveryAvailable()) {
      throw new ApiError({ code: 'email_delivery_unavailable', message: 'Invitation mail delivery is not configured', statusCode: 409 })
    }
    const token = randomBytes(32).toString('base64url')
    const [created] = await this.database.db.transaction(async (tx) => {
      const [actor] = await tx.select({ login: accounts.login }).from(accounts).where(eq(accounts.id, actorAccountId)).limit(1)
      const [invitation] = await tx.insert(registrationInvitations).values({
        tokenKeyId: 'auth-secret-v1', tokenHash: this.hash(token), tokenHint: token.slice(-4),
        createdByActorType: 'account', createdByActorId: actorAccountId, creatorSnapshot: { login: actor?.login ?? 'deleted' },
        expiresAt: input.expiresAt, maxUses, note: input.note?.trim() || null,
        ...(boundEmail === undefined ? {} : { boundEmailNormalized: boundEmail }),
      }).returning({ id: registrationInvitations.id, expiresAt: registrationInvitations.expiresAt })
      if (invitation === undefined) throw new Error('Invitation insert returned no row')
      if (input.send === true && boundEmail !== undefined && this.mail !== undefined) {
        const idempotencyKey = `invitation:${invitation.id}:initial`
        const secretPayloadRef = await this.mail.secrets.createInTransaction(tx, {
          idempotencyKey,
          to: boundEmail,
          template: 'invitation',
          locale: this.config.mailDefaultLocale,
          variables: { actionUrl: `${this.config.publicBaseUrl.replace(/\/$/, '')}/#/accept-invite/${token}` },
        }, invitation.expiresAt)
        await this.mail.outbox.enqueueInTransaction(tx, {
          template: 'invitation',
          recipientRef: createHmac('sha256', this.config.authSecret).update(`mail-recipient:v1:${boundEmail}`).digest('base64url'),
          payload: { invitationId: invitation.id, delivery: 'initial' }, secretPayloadRef,
          requestHash: createHmac('sha256', this.config.authSecret).update(`invitation-mail:v1:${invitation.id}:initial`).digest('base64url'),
          idempotencyKey,
        })
      }
      await tx.insert(adminAuditLogs).values({ actorAccountId, action: 'invitation.create', targetType: 'registration-invitation', targetId: invitation.id, metadata: { maxUses, expiresAt: invitation.expiresAt.toISOString() } })
      return [invitation]
    })
    if (created === undefined) throw new Error('Invitation transaction returned no row')
    return { id: created.id, token, url: `${this.config.webPublicBaseUrl}/#/accept-invite/${token}`, expiresAt: created.expiresAt, deliveryQueued: input.send === true }
  }

  async inspect(token: string): Promise<{ canContinue: boolean, requiresEmail: boolean, serverName: string }> {
    const hash = this.hash(token)
    const [invitation] = await this.database.db.select({ tokenHash: registrationInvitations.tokenHash, expiresAt: registrationInvitations.expiresAt, revokedAt: registrationInvitations.revokedAt, useCount: registrationInvitations.useCount, maxUses: registrationInvitations.maxUses, boundEmailNormalized: registrationInvitations.boundEmailNormalized })
      .from(registrationInvitations).where(eq(registrationInvitations.tokenHash, hash)).limit(1)
    const valid = invitation !== undefined && timingSafeEqual(Buffer.from(invitation.tokenHash), Buffer.from(hash))
      && invitation.revokedAt === null && invitation.expiresAt > new Date() && invitation.useCount < invitation.maxUses
      && this.deployment.getState().registrationPolicy === 'invitation'
    return { canContinue: valid, requiresEmail: valid && invitation?.boundEmailNormalized !== null, serverName: this.config.serverName }
  }

  async accept(input: { token: string, login: string, password: string, email?: string, requestId: string }): Promise<{ id: string, login: string, isAdmin: false, totpEnabled: false }> {
    if (this.deployment.getState().registrationPolicy !== 'invitation') {
      throw new ApiError({ code: 'invitation_invalid', message: 'Invitation is invalid or unavailable', statusCode: 403 })
    }
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id })
    const hash = this.hash(input.token)
    try {
      const account = await this.database.db.transaction(async (tx) => {
        const [invitation] = await tx.select().from(registrationInvitations).where(eq(registrationInvitations.tokenHash, hash)).limit(1)
        const valid = invitation !== undefined && timingSafeEqual(Buffer.from(invitation.tokenHash), Buffer.from(hash))
          && invitation.revokedAt === null && invitation.expiresAt > new Date() && invitation.useCount < invitation.maxUses
        if (!valid || invitation === undefined) throw new ApiError({ code: 'invitation_invalid', message: 'Invitation is invalid or unavailable', statusCode: 403 })
        if (invitation.boundEmailNormalized !== null) {
          const acceptedEmail = input.email === undefined ? undefined : normalizeEmail(input.email)
          if (acceptedEmail !== invitation.boundEmailNormalized) {
            throw new ApiError({ code: 'invitation_invalid', message: 'Invitation is invalid or unavailable', statusCode: 403 })
          }
        }
        const consumed = await tx.update(registrationInvitations).set({ useCount: sql`${registrationInvitations.useCount} + 1`, updatedAt: new Date() }).where(and(
          eq(registrationInvitations.id, invitation.id), isNull(registrationInvitations.revokedAt), gt(registrationInvitations.expiresAt, new Date()), lt(registrationInvitations.useCount, registrationInvitations.maxUses),
        )).returning({ id: registrationInvitations.id })
        if (consumed.length !== 1) throw new ApiError({ code: 'invitation_invalid', message: 'Invitation is invalid or unavailable', statusCode: 403 })
        const [created] = await tx.insert(accounts).values({ login: input.login.trim(), passwordHash, isAdmin: false, identityState: 'active' }).returning({ id: accounts.id, login: accounts.login })
        if (created === undefined) throw new Error('Account insert returned no row')
        const normalizedLogin = normalizeLoginKey(created.login)
        const [identity] = await tx.insert(accountIdentities).values({ accountId: created.id, kind: 'username', identifier: created.login, normalizedIdentifier: normalizedLogin, isPrimary: true }).returning({ id: accountIdentities.id })
        if (identity === undefined) throw new Error('Invitation username identity insert returned no row')
        await tx.insert(accountLoginClaims).values({ normalizedLoginKey: normalizedLogin, accountId: created.id, identityId: identity.id, kind: 'username' })
        await tx.insert(registrationInvitationUses).values({ invitationId: invitation.id, accountId: created.id, requestId: input.requestId })
        return created
      })
      return { ...account, isAdmin: false, totpEnabled: false }
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError({ code: 'account_exists', message: 'Account already exists', statusCode: 409 })
      throw error
    }
  }

  async list(actorAccountId: string) {
    await this.assertAdmin(actorAccountId)
    const invitations = await this.database.db.select({ id: registrationInvitations.id, tokenHint: registrationInvitations.tokenHint, expiresAt: registrationInvitations.expiresAt, revokedAt: registrationInvitations.revokedAt, maxUses: registrationInvitations.maxUses, useCount: registrationInvitations.useCount, note: registrationInvitations.note, createdAt: registrationInvitations.createdAt }).from(registrationInvitations).orderBy(sql`${registrationInvitations.createdAt} desc`).limit(200)
    const ids = invitations.map((invitation) => invitation.id)
    const deliveries = ids.length === 0 ? [] : await this.database.sql<Array<{
      invitation_id: string, status: 'pending' | 'sending' | 'sent' | 'dead_letter' | 'delivery_unknown', last_error_code: string | null,
    }>>`
      select payload->>'invitationId' as invitation_id, status, last_error_code
      from outbox_messages
      where channel = 'mail' and template_or_event = 'invitation'
        and payload->>'invitationId' = any(${this.database.sql.array(ids)}::text[])`
    const deliveryByInvitation = new Map(deliveries.map((delivery) => [delivery.invitation_id, delivery]))
    return invitations.map((invitation) => {
      const delivery = deliveryByInvitation.get(invitation.id)
      return {
        ...invitation,
        paused: this.deployment.getState().registrationPolicy !== 'invitation',
        delivery: delivery === undefined ? null : { status: delivery.status, errorCode: delivery.last_error_code },
      }
    })
  }

  async revoke(actorAccountId: string, invitationId: string): Promise<void> {
    await this.assertAdmin(actorAccountId)
    const secretPayloadRefs = await this.database.db.transaction(async (tx) => {
      const changed = await tx.update(registrationInvitations).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(eq(registrationInvitations.id, invitationId), isNull(registrationInvitations.revokedAt))).returning({ id: registrationInvitations.id })
      if (changed.length !== 1) throw new ApiError({ code: 'invitation_not_found', message: 'Invitation was not found', statusCode: 404 })
      const refs = await this.cancelQueuedDeliveryInTransaction(tx, invitationId)
      await tx.insert(adminAuditLogs).values({ actorAccountId, action: 'invitation.revoke', targetType: 'registration-invitation', targetId: invitationId })
      return refs
    })
    for (const ref of secretPayloadRefs) await this.mail?.secrets.erase(ref)
  }

  /** Replaces a bound-email invitation atomically; the old bearer token is
   * revoked before the new encrypted mail intent becomes visible. */
  async replaceAndSend(actorAccountId: string, invitationId: string): Promise<{ id: string, expiresAt: Date, deliveryQueued: true }> {
    await this.assertAdmin(actorAccountId)
    if (!this.deliveryAvailable()) {
      throw new ApiError({ code: 'email_delivery_unavailable', message: 'Invitation mail delivery is not configured', statusCode: 409 })
    }
    const token = randomBytes(32).toString('base64url')
    const { invitation, oldSecretPayloadRefs } = await this.database.db.transaction(async (tx) => {
      const [old] = await tx.select().from(registrationInvitations).where(eq(registrationInvitations.id, invitationId)).limit(1).for('update')
      if (old === undefined || old.revokedAt !== null || old.expiresAt <= new Date() || old.useCount >= old.maxUses || old.boundEmailNormalized === null) {
        throw new ApiError({ code: 'invitation_not_replaceable', message: 'Invitation cannot be replaced', statusCode: 409 })
      }
      await tx.update(registrationInvitations).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(registrationInvitations.id, old.id))
      const oldSecretPayloadRefs = await this.cancelQueuedDeliveryInTransaction(tx, old.id)
      const [replacement] = await tx.insert(registrationInvitations).values({
        tokenKeyId: 'auth-secret-v1', tokenHash: this.hash(token), tokenHint: token.slice(-4),
        createdByActorType: 'account', createdByActorId: actorAccountId, creatorSnapshot: old.creatorSnapshot,
        boundEmailNormalized: old.boundEmailNormalized, maxUses: 1, expiresAt: old.expiresAt,
        note: old.note, replacesInvitationId: old.id,
      }).returning({ id: registrationInvitations.id, expiresAt: registrationInvitations.expiresAt })
      if (replacement === undefined) throw new Error('Replacement invitation insert returned no row')
      if (this.mail === undefined) throw new Error('Mail delivery dependency is unavailable')
      const idempotencyKey = `invitation:${replacement.id}:replacement`
      const secretPayloadRef = await this.mail.secrets.createInTransaction(tx, {
        idempotencyKey,
        to: old.boundEmailNormalized,
        template: 'invitation', locale: this.config.mailDefaultLocale,
        variables: { actionUrl: `${this.config.publicBaseUrl.replace(/\/$/, '')}/#/accept-invite/${token}` },
      }, replacement.expiresAt)
      await this.mail.outbox.enqueueInTransaction(tx, {
        template: 'invitation',
        recipientRef: createHmac('sha256', this.config.authSecret).update(`mail-recipient:v1:${old.boundEmailNormalized}`).digest('base64url'),
        payload: { invitationId: replacement.id, delivery: 'replacement' }, secretPayloadRef,
        requestHash: createHmac('sha256', this.config.authSecret).update(`invitation-mail:v1:${replacement.id}:replacement`).digest('base64url'),
        idempotencyKey,
      })
      await tx.insert(adminAuditLogs).values({ actorAccountId, action: 'invitation.replace-and-send', targetType: 'registration-invitation', targetId: replacement.id, metadata: { replacesInvitationId: old.id, expiresAt: replacement.expiresAt.toISOString() } })
      return { invitation: replacement, oldSecretPayloadRefs }
    })
    for (const ref of oldSecretPayloadRefs) await this.mail?.secrets.erase(ref)
    return { ...invitation, deliveryQueued: true }
  }

  async setRegistrationPolicy(actorAccountId: string, policy: 'disabled' | 'invitation' | 'public'): Promise<void> {
    await this.assertAdmin(actorAccountId)
    if (this.deployment.getState().deploymentMode !== 'self-hosted') {
      throw new ApiError({ code: 'registration_policy_not_available', message: 'Registration policy is managed by the hosted control plane', statusCode: 403 })
    }
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-registration-policy'))`)
      await tx.execute(sql`update deployment_settings set registration_policy = ${policy}::registration_policy, configuration_revision = configuration_revision + 1, updated_at = now() where id = true`)
      await tx.insert(adminAuditLogs).values({ actorAccountId, action: 'registration-policy.update', targetType: 'deployment', targetId: 'singleton', metadata: { policy } })
    })
    await this.deployment.reload()
  }

  private async assertAdmin(accountId: string): Promise<void> {
    const [account] = await this.database.db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.isAdmin, true), isNull(accounts.suspendedAt), isNull(accounts.disabledAt))).limit(1)
    if (account === undefined) throw new ApiError({ code: 'admin_required', message: 'Administrator access is required', statusCode: 403 })
  }

  /** Pending messages can be safely cancelled; a worker that already holds a
   * lease may finish, but the revoked token in that message is unusable. */
  private async cancelQueuedDeliveryInTransaction(tx: any, invitationId: string): Promise<string[]> {
    const cancelled = await tx.update(outboxMessages).set({
      status: 'dead_letter', lastErrorCode: 'invitation_revoked', lockedAt: null, lockedBy: null, leaseExpiresAt: null,
    }).where(and(
      eq(outboxMessages.channel, 'mail'), eq(outboxMessages.templateOrEvent, 'invitation'), eq(outboxMessages.status, 'pending'),
      sql`${outboxMessages.payload}->>'invitationId' = ${invitationId}`,
    )).returning({ secretPayloadRef: outboxMessages.secretPayloadRef })
    return cancelled.flatMap((item: { secretPayloadRef: string | null }) => item.secretPayloadRef === null ? [] : [item.secretPayloadRef])
  }

  private hash(token: string): string { return createHmac('sha256', this.config.authSecret).update(token).digest('base64url') }

  private deliveryAvailable(): boolean {
    const available = this.mail?.deliveryAvailable
    return typeof available === 'function' ? available() : available === true
  }
}

function isUniqueViolation(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' }
