import { createHmac, randomBytes } from 'node:crypto'
import { domainToASCII } from 'node:url'
import argon2 from 'argon2'
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { accountActionTokens, accountIdentities, accountLoginClaims, accounts, deviceAuthorizations, devicePairings, refreshTokens, riskEvents, webSessions } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { MailOutboxService } from '../mail/outbox-service.js'
import type { MailTemplateId } from '../mail/provider.js'
import type { MailSecretPayloadService } from '../mail/secret-payload-service.js'
import type { RiskService } from '../risk/service.js'

const verificationTtlMs = 30 * 60 * 1_000
const passwordResetTtlMs = 15 * 60 * 1_000

export interface EmailIdentityCapabilities {
  readonly emailVerification: boolean
  readonly passwordReset: boolean
}

/** Hosted email identity state machine; actual delivery stays behind MailOutbox. */
export class EmailIdentityService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly mailOutbox: MailOutboxService,
    private readonly mailSecrets: MailSecretPayloadService,
    private readonly capabilities: EmailIdentityCapabilities,
    private readonly risk?: RiskService,
  ) {}

  async register(email: string, password: string): Promise<{ accountId: string }> {
    this.assertEmailVerificationEnabled()
    const normalized = normalizeEmail(email)
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    try {
      return await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-email:${normalized}`}))`)
        const [created] = await tx.insert(accounts).values({
          login: email.trim(), passwordHash, isAdmin: false, identityState: 'pending_verification',
        }).returning({ id: accounts.id })
        if (created === undefined) throw new Error('Email account insert returned no row')
        try {
          const [identity] = await tx.insert(accountIdentities).values({
            accountId: created.id, kind: 'email', identifier: email.trim(), normalizedIdentifier: normalized, isPrimary: true,
          }).returning({ id: accountIdentities.id })
          if (identity === undefined) throw new Error('Email identity insert returned no row')
          await tx.insert(accountLoginClaims).values({ normalizedLoginKey: normalized, accountId: created.id, identityId: identity.id, kind: 'email' })
          const issued = await this.createTokenInTransaction(tx, created.id, identity.id, 'verify_email')
          await this.enqueueActionMailInTransaction(tx, email.trim(), created.id, issued, 'verify_email')
        } catch (error) {
          if (databaseErrorCode(error) === '23505') {
            throw new ApiError({ code: 'identity_conflict', message: 'This email cannot be used', statusCode: 409 })
          }
          throw error
        }
        return { accountId: created.id }
      })
    } catch (error) {
      if (databaseErrorCode(error) === '23505') {
        throw new ApiError({ code: 'identity_conflict', message: 'This email cannot be used', statusCode: 409 })
      }
      throw error
    }
  }

  async verify(token: string): Promise<{ accountId: string }> {
    this.assertEmailVerificationEnabled()
    const hash = this.tokenHash('verify_email', token)
    return await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({
        id: accountActionTokens.id, accountId: accountActionTokens.accountId, identityId: accountActionTokens.identityId,
        expiresAt: accountActionTokens.expiresAt, consumedAt: accountActionTokens.consumedAt, revokedAt: accountActionTokens.revokedAt,
      }).from(accountActionTokens).where(and(
        eq(accountActionTokens.tokenHash, hash), eq(accountActionTokens.purpose, 'verify_email'),
      )).limit(1).for('update')
      if (row === undefined || row.accountId === null || row.identityId === null || row.revokedAt !== null) {
        throw new ApiError({ code: 'action_token_invalid', message: 'Verification token is invalid', statusCode: 400 })
      }
      // Verification links are often opened twice by mail clients or browser
      // prefetch protection. Consumption is idempotent and reveals no profile
      // state beyond the caller already possessing the bearer token.
      if (row.consumedAt !== null) return { accountId: row.accountId }
      if (row.expiresAt <= new Date()) throw new ApiError({ code: 'action_token_expired', message: 'Verification token has expired', statusCode: 409 })
      await tx.update(accountActionTokens).set({ consumedAt: new Date() }).where(eq(accountActionTokens.id, row.id))
      await tx.update(accountIdentities).set({ verifiedAt: new Date(), updatedAt: new Date() }).where(eq(accountIdentities.id, row.identityId))
      await tx.update(accounts).set({ identityState: 'active', updatedAt: new Date() }).where(eq(accounts.id, row.accountId))
      return { accountId: row.accountId }
    })
  }

  /** Publicly indistinguishable resend request; delivery is deliberately deferred to MailOutbox. */
  async resend(email: string): Promise<void> {
    this.assertEmailVerificationEnabled()
    const normalized = normalizeEmail(email)
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-email:${normalized}`}))`)
      const [identity] = await tx.select({ id: accountIdentities.id, accountId: accountIdentities.accountId, verifiedAt: accountIdentities.verifiedAt })
        .from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId)).where(and(
          eq(accountIdentities.kind, 'email'), eq(accountIdentities.normalizedIdentifier, normalized),
          isNull(accountIdentities.disabledAt), eq(accounts.identityState, 'pending_verification'),
        )).limit(1)
      if (identity === undefined || identity.verifiedAt !== null) return
      await tx.update(accountActionTokens).set({ revokedAt: new Date() }).where(and(
        eq(accountActionTokens.accountId, identity.accountId), eq(accountActionTokens.purpose, 'verify_email'),
        isNull(accountActionTokens.consumedAt), isNull(accountActionTokens.revokedAt), gt(accountActionTokens.expiresAt, new Date()),
      ))
      const issued = await this.createTokenInTransaction(tx, identity.accountId, identity.id, 'verify_email')
      await this.enqueueActionMailInTransaction(tx, email.trim(), identity.accountId, issued, 'verify_email')
    })
  }

  /** Controlled test seam; raw tokens are never persisted or returned by web flows. */
  async issueInternalTestVerificationToken(accountId: string): Promise<{ token: string, expiresAt: Date }> {
    this.assertEmailVerificationEnabled()
    return await this.database.db.transaction(async (tx) => {
      const [identity] = await tx.select({ id: accountIdentities.id }).from(accountIdentities).where(and(
        eq(accountIdentities.accountId, accountId), eq(accountIdentities.kind, 'email'), isNull(accountIdentities.disabledAt),
      )).limit(1)
      if (identity === undefined) throw new ApiError({ code: 'email_identity_not_found', message: 'Email identity was not found', statusCode: 404 })
      await tx.update(accountActionTokens).set({ revokedAt: new Date() }).where(and(
        eq(accountActionTokens.accountId, accountId), eq(accountActionTokens.purpose, 'verify_email'),
        isNull(accountActionTokens.consumedAt), isNull(accountActionTokens.revokedAt), gt(accountActionTokens.expiresAt, new Date()),
      ))
      return await this.createTokenInTransaction(tx, accountId, identity.id, 'verify_email')
    })
  }

  /** Always succeeds outwardly so the request endpoint cannot enumerate email identities. */
  async requestPasswordReset(email: string): Promise<void> {
    this.assertPasswordResetEnabled()
    const normalized = normalizeEmail(email)
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notegen-email:${normalized}`}))`)
      const [identity] = await tx.select({ id: accountIdentities.id, accountId: accountIdentities.accountId }).from(accountIdentities)
        .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId)).where(and(
          eq(accountIdentities.kind, 'email'), eq(accountIdentities.normalizedIdentifier, normalized),
          isNull(accountIdentities.disabledAt), sql`${accountIdentities.verifiedAt} is not null`,
          eq(accounts.identityState, 'active'), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
        )).limit(1)
      if (identity === undefined) return
      await this.revokeOutstandingTokens(tx, identity.accountId, 'reset_password')
      const issued = await this.createTokenInTransaction(tx, identity.accountId, identity.id, 'reset_password')
      await this.enqueueActionMailInTransaction(tx, email.trim(), identity.accountId, issued, 'reset_password')
    })
  }

  /** Controlled test seam; production delivery must use MailOutbox and never return this value. */
  async issueInternalTestPasswordResetToken(accountId: string): Promise<{ token: string, expiresAt: Date }> {
    this.assertPasswordResetEnabled()
    return await this.database.db.transaction(async (tx) => {
      const [identity] = await tx.select({ id: accountIdentities.id }).from(accountIdentities).where(and(
        eq(accountIdentities.accountId, accountId), eq(accountIdentities.kind, 'email'),
        isNull(accountIdentities.disabledAt), sql`${accountIdentities.verifiedAt} is not null`,
      )).limit(1)
      if (identity === undefined) throw new ApiError({ code: 'email_identity_not_found', message: 'Verified email identity was not found', statusCode: 404 })
      await this.revokeOutstandingTokens(tx, accountId, 'reset_password')
      return await this.createTokenInTransaction(tx, accountId, identity.id, 'reset_password')
    })
  }

  async resetPassword(token: string, password: string): Promise<{ accountId: string, credentialEpoch: string }> {
    this.assertPasswordResetEnabled()
    const hash = this.tokenHash('reset_password', token)
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    return await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({
        id: accountActionTokens.id, accountId: accountActionTokens.accountId,
        expiresAt: accountActionTokens.expiresAt, consumedAt: accountActionTokens.consumedAt, revokedAt: accountActionTokens.revokedAt,
      }).from(accountActionTokens).where(and(
        eq(accountActionTokens.tokenHash, hash), eq(accountActionTokens.purpose, 'reset_password'),
      )).limit(1).for('update')
      if (row === undefined || row.accountId === null || row.revokedAt !== null) {
        throw new ApiError({ code: 'action_token_invalid', message: 'Password reset token is invalid', statusCode: 400 })
      }
      if (row.consumedAt !== null) throw new ApiError({ code: 'action_token_consumed', message: 'Password reset token was already used', statusCode: 409 })
      if (row.expiresAt <= new Date()) throw new ApiError({ code: 'action_token_expired', message: 'Password reset token has expired', statusCode: 409 })
      const [account] = await tx.select({ id: accounts.id }).from(accounts).where(and(
        eq(accounts.id, row.accountId), eq(accounts.identityState, 'active'), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
      )).limit(1).for('update')
      if (account === undefined) throw new ApiError({ code: 'action_token_invalid', message: 'Password reset token is invalid', statusCode: 400 })
      await this.risk?.enforceAccountInTransaction(tx, account.id, 'authentication')
      const now = new Date()
      const [updated] = await tx.update(accounts).set({
        passwordHash, credentialEpoch: sql`${accounts.credentialEpoch} + 1`, updatedAt: now,
      }).where(eq(accounts.id, account.id)).returning({ credentialEpoch: accounts.credentialEpoch })
      if (updated === undefined) throw new Error('Password reset account update returned no row')
      await tx.update(accountActionTokens).set({ consumedAt: now }).where(eq(accountActionTokens.id, row.id))
      await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.accountId, account.id), isNull(refreshTokens.revokedAt)))
      await tx.delete(webSessions).where(eq(webSessions.accountId, account.id))
      // Device authorization is a bearer ceremony. Both a previously approved
      // code and a pending code that could be approved after this reset must
      // be invalidated, otherwise a pre-reset browser can mint a new session.
      await tx.update(deviceAuthorizations).set({ status: 'denied' }).where(and(
        eq(deviceAuthorizations.accountId, account.id), inArray(deviceAuthorizations.status, ['pending', 'approved']),
        isNull(deviceAuthorizations.consumedAt), gt(deviceAuthorizations.expiresAt, now),
      ))
      await tx.delete(devicePairings).where(and(eq(devicePairings.accountId, account.id), isNull(devicePairings.consumedAt)))
      await this.revokeOutstandingTokens(tx, account.id, 'reset_password', row.id, now)
      await tx.insert(riskEvents).values({
        eventType: 'authentication.password-reset', accountId: account.id,
        requestId: `password-reset:${row.id}`, outcome: 'allowed', reasonCodes: [],
        metadata: { source: 'email-action-token', tokenKeyId: 'auth-secret-v1' },
      })
      return { accountId: account.id, credentialEpoch: updated.credentialEpoch.toString() }
    })
  }

  private async revokeOutstandingTokens(tx: any, accountId: string, purpose: 'verify_email' | 'reset_password', exceptId?: string, now = new Date()): Promise<void> {
    await tx.update(accountActionTokens).set({ revokedAt: now }).where(and(
      eq(accountActionTokens.accountId, accountId), eq(accountActionTokens.purpose, purpose),
      isNull(accountActionTokens.consumedAt), isNull(accountActionTokens.revokedAt), gt(accountActionTokens.expiresAt, now),
      ...(exceptId === undefined ? [] : [sql`${accountActionTokens.id} <> ${exceptId}`]),
    ))
  }

  private async createTokenInTransaction(tx: any, accountId: string, identityId: string, purpose: 'verify_email' | 'reset_password'): Promise<{ id: string, token: string, expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + (purpose === 'verify_email' ? verificationTtlMs : passwordResetTtlMs))
    const [created] = await tx.insert(accountActionTokens).values({
      accountId, identityId, purpose, tokenKeyId: 'auth-secret-v1', tokenHash: this.tokenHash(purpose, token), expiresAt,
    }).returning({ id: accountActionTokens.id })
    if (created === undefined) throw new Error('Email action token insert returned no row')
    return { id: created.id, token, expiresAt }
  }

  private async enqueueActionMailInTransaction(
    tx: any,
    email: string,
    accountId: string,
    issued: { id: string, token: string, expiresAt: Date },
    purpose: 'verify_email' | 'reset_password',
  ): Promise<void> {
    const template: MailTemplateId = purpose === 'verify_email' ? 'verify-email' : 'reset-password'
    const idempotencyKey = `account-action:${issued.id}`
    const secretPayloadRef = await this.mailSecrets.createInTransaction(tx, {
      idempotencyKey,
      to: email,
      template,
      locale: this.config.mailDefaultLocale,
      variables: { actionUrl: `${this.config.publicBaseUrl.replace(/\/$/, '')}/account/${purpose === 'verify_email' ? 'verify-email' : 'reset-password'}?token=${encodeURIComponent(issued.token)}` },
    }, issued.expiresAt)
    await this.mailOutbox.enqueueInTransaction(tx, {
      template,
      // A stable keyed digest supports queue correlation without exposing an
      // email address in the durable outbox or operational SQL queries.
      recipientRef: createHmac('sha256', this.config.authSecret).update(`mail-recipient:v1:${normalizeEmail(email)}`).digest('base64url'),
      payload: { actionTokenId: issued.id, accountId, purpose },
      secretPayloadRef,
      requestHash: createHmac('sha256', this.config.authSecret).update(`mail-outbox:v1:${issued.id}:${template}`).digest('base64url'),
      idempotencyKey,
    })
  }

  private tokenHash(purpose: 'verify_email' | 'reset_password', token: string): string {
    return createHmac('sha256', this.config.authSecret).update(`account-action:v1:${purpose}:${token}`).digest('base64url')
  }

  private assertInternalHosted(): void {
    if (this.config.deploymentMode !== 'hosted' || this.config.hostedReleaseStage !== 'internal-test') {
      throw new ApiError({ code: 'email_internal_test_only', message: 'Hosted email identity is not enabled in this deployment', statusCode: 403 })
    }
  }

  private assertEmailVerificationEnabled(): void {
    this.assertInternalHosted()
    if (!this.capabilities.emailVerification) {
      throw new ApiError({ code: 'email_verification_unavailable', message: 'Email verification is not enabled', statusCode: 403 })
    }
  }

  private assertPasswordResetEnabled(): void {
    this.assertInternalHosted()
    if (!this.capabilities.passwordReset) {
      throw new ApiError({ code: 'password_reset_unavailable', message: 'Password reset is not enabled', statusCode: 403 })
    }
  }
}

export function normalizeEmail(value: string): string {
  const trimmed = value.trim().normalize('NFKC')
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) throw new ApiError({ code: 'email_invalid', message: 'Email address is invalid', statusCode: 400 })
  const local = trimmed.slice(0, at)
  const domain = domainToASCII(trimmed.slice(at + 1))
  if (local.length > 64 || /\s/.test(local) || !domain || domain.length > 253 || !domain.includes('.')) {
    throw new ApiError({ code: 'email_invalid', message: 'Email address is invalid', statusCode: 400 })
  }
  return `${local.toLocaleLowerCase('und')}@${domain.toLowerCase()}`
}

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}
