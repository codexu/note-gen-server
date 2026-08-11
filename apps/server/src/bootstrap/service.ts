import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { accountActionTokens, accountIdentities, accountLoginClaims, accounts, adminAuditLogs, bootstrapCredentials, deploymentSettings, deviceAuthorizations, devicePairings, refreshTokens, restoreMarkers, webSessions } from '../database/schema.js'
import { ApiError } from '../errors.js'
import { normalizeLoginKey } from '../identity/service.js'
import type { DeploymentService } from '../deployment/service.js'

export class BootstrapService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly deployment: DeploymentService,
  ) {}

  async initialize(): Promise<void> {
    if (!this.deployment.canBootstrapAdministrator()) return
    const [restoreRequiresReissue] = await this.database.db.select({ id: restoreMarkers.id }).from(restoreMarkers)
      .where(eq(restoreMarkers.bootstrapReissueRequired, true)).limit(1)
    if (restoreRequiresReissue !== undefined) return
    const tokenHash = this.hash(this.config.setupToken)
    await this.database.db.insert(bootstrapCredentials).values({
      source: 'legacy_environment', tokenKeyId: 'auth-secret-v1', tokenHash,
      tokenHint: this.config.setupToken.slice(-4), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    }).onConflictDoNothing({ target: bootstrapCredentials.tokenHash })
  }

  async issueWebToken(ttlSeconds = 30 * 60): Promise<{ token: string, expiresAt: Date }> {
    if (!this.deployment.canBootstrapAdministrator()) {
      throw new ApiError({ code: 'setup_not_required', message: 'Setup is not available', statusCode: 404 })
    }
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + Math.min(Math.max(ttlSeconds, 60), 24 * 60 * 60) * 1_000)
    await this.database.db.transaction(async (tx) => {
      await tx.insert(bootstrapCredentials).values({
        source: 'cli', tokenKeyId: 'auth-secret-v1', tokenHash: this.hash(token), tokenHint: token.slice(-4), expiresAt,
      })
      await tx.update(restoreMarkers).set({ bootstrapReissueRequired: false }).where(eq(restoreMarkers.bootstrapReissueRequired, true))
    })
    return { token, expiresAt }
  }

  async complete(login: string, password: string, token: string): Promise<{ id: string, login: string, isAdmin: true, totpEnabled: false }> {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    const suppliedHash = this.hash(token)
    try {
      const account = await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-bootstrap'))`)
        const [settings] = await tx.select().from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
        if (settings === undefined || settings.deploymentMode !== 'self-hosted'
          || settings.registrationPolicy !== 'bootstrap' || settings.selfHostedLifecycle !== 'uninitialized') {
          throw new ApiError({ code: 'setup_already_completed', message: 'Setup has already been completed', statusCode: 409 })
        }
        const [restoreRequiresReissue] = await tx.select({ id: restoreMarkers.id }).from(restoreMarkers)
          .where(eq(restoreMarkers.bootstrapReissueRequired, true)).limit(1)
        if (restoreRequiresReissue !== undefined) {
          throw new ApiError({ code: 'setup_reissue_required', message: 'A new local setup credential is required after restore', statusCode: 409 })
        }
        const [credential] = await tx.select().from(bootstrapCredentials).where(and(
          eq(bootstrapCredentials.tokenHash, suppliedHash), gt(bootstrapCredentials.expiresAt, new Date()),
          isNull(bootstrapCredentials.consumedAt), isNull(bootstrapCredentials.revokedAt),
        )).limit(1)
        if (credential === undefined || !timingSafeEqual(Buffer.from(credential.tokenHash), Buffer.from(suppliedHash))) {
          throw new ApiError({ code: 'setup_token_invalid', message: 'Setup token is invalid or expired', statusCode: 403 })
        }
        const [existing] = await tx.select({ id: accounts.id }).from(accounts).limit(1)
        if (existing !== undefined) throw new ApiError({ code: 'setup_already_completed', message: 'Setup has already been completed', statusCode: 409 })
        const [created] = await tx.insert(accounts).values({ login: login.trim(), passwordHash, isAdmin: true, identityState: 'active' })
          .returning({ id: accounts.id, login: accounts.login })
        if (created === undefined) throw new Error('Bootstrap account insert returned no row')
        const normalizedLogin = normalizeLoginKey(created.login)
        const [identity] = await tx.insert(accountIdentities).values({ accountId: created.id, kind: 'username', identifier: created.login, normalizedIdentifier: normalizedLogin, isPrimary: true }).returning({ id: accountIdentities.id })
        if (identity === undefined) throw new Error('Bootstrap username identity insert returned no row')
        await tx.insert(accountLoginClaims).values({ normalizedLoginKey: normalizedLogin, accountId: created.id, identityId: identity.id, kind: 'username' })
        await tx.update(deploymentSettings).set({ registrationPolicy: 'disabled', selfHostedLifecycle: 'ready', initializedAt: new Date(), initializedByAccountId: created.id, updatedAt: new Date(), configurationRevision: sql`${deploymentSettings.configurationRevision} + 1` }).where(eq(deploymentSettings.id, true))
        await tx.update(bootstrapCredentials).set({ consumedAt: new Date() }).where(eq(bootstrapCredentials.id, credential.id))
        await tx.update(bootstrapCredentials).set({ revokedAt: new Date() }).where(and(isNull(bootstrapCredentials.consumedAt), isNull(bootstrapCredentials.revokedAt)))
        await tx.insert(adminAuditLogs).values({
          actorAccountId: created.id, action: 'instance.bootstrap-complete', targetType: 'deployment', targetId: 'singleton',
          metadata: { credentialSource: credential.source },
        })
        return created
      })
      await this.deployment.reload()
      return { ...account, isAdmin: true, totpEnabled: false }
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError({ code: 'account_exists', message: 'Account already exists', statusCode: 409 })
      throw error
    }
  }

  /** Local-only repair path for an already initialized self-hosted instance. */
  async repairAdministrator(login: string, password: string): Promise<{ id: string, login: string, isAdmin: true, totpEnabled: false }> {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    try {
      const account = await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-admin-repair'))`)
        const [settings] = await tx.select().from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
        if (settings === undefined || settings.deploymentMode !== 'self-hosted' || settings.selfHostedLifecycle !== 'ready' || !settings.adminRepairRequired) {
          throw new ApiError({ code: 'admin_repair_not_required', message: 'Administrator repair is not available', statusCode: 409 })
        }
        const [activeAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.isAdmin, true), isNull(accounts.suspendedAt), isNull(accounts.disabledAt))).limit(1)
        if (activeAdmin !== undefined) throw new ApiError({ code: 'admin_repair_not_required', message: 'An active administrator already exists', statusCode: 409 })
        const requestedLogin = login.trim()
        const normalizedLogin = normalizeLoginKey(requestedLogin)
        const [existing] = await tx.select({ id: accounts.id, login: accounts.login })
          .from(accountLoginClaims).innerJoin(accounts, eq(accounts.id, accountLoginClaims.accountId))
          .where(and(eq(accountLoginClaims.normalizedLoginKey, normalizedLogin), isNull(accountLoginClaims.releasedAt))).limit(1).for('update')
        let repaired: { id: string, login: string }
        let existingAccount = false
        if (existing !== undefined) {
          existingAccount = true
          const now = new Date()
          const [updated] = await tx.update(accounts).set({
            isAdmin: true, passwordHash, suspendedAt: null, disabledAt: null,
            totpSecret: null, totpEnabledAt: null,
            credentialEpoch: sql`${accounts.credentialEpoch} + 1`, updatedAt: now,
          }).where(eq(accounts.id, existing.id)).returning({ id: accounts.id, login: accounts.login })
          if (updated === undefined) throw new Error('Repair administrator update returned no row')
          await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.accountId, existing.id), isNull(refreshTokens.revokedAt)))
          await tx.delete(webSessions).where(eq(webSessions.accountId, existing.id))
          await tx.update(accountActionTokens).set({ revokedAt: now }).where(and(eq(accountActionTokens.accountId, existing.id), isNull(accountActionTokens.consumedAt), isNull(accountActionTokens.revokedAt)))
          await tx.update(deviceAuthorizations).set({ status: 'denied' }).where(and(eq(deviceAuthorizations.accountId, existing.id), isNull(deviceAuthorizations.consumedAt)))
          await tx.delete(devicePairings).where(and(eq(devicePairings.accountId, existing.id), isNull(devicePairings.consumedAt)))
          repaired = updated
        } else {
          const [created] = await tx.insert(accounts).values({ login: requestedLogin, passwordHash, isAdmin: true, identityState: 'active' }).returning({ id: accounts.id, login: accounts.login })
          if (created === undefined) throw new Error('Repair administrator insert returned no row')
          const [identity] = await tx.insert(accountIdentities).values({ accountId: created.id, kind: 'username', identifier: created.login, normalizedIdentifier: normalizedLogin, isPrimary: true }).returning({ id: accountIdentities.id })
          if (identity === undefined) throw new Error('Repair username identity insert returned no row')
          await tx.insert(accountLoginClaims).values({ normalizedLoginKey: normalizedLogin, accountId: created.id, identityId: identity.id, kind: 'username' })
          repaired = created
        }
        await tx.update(deploymentSettings).set({ adminRepairRequired: false, configurationRevision: sql`${deploymentSettings.configurationRevision} + 1`, updatedAt: new Date() }).where(eq(deploymentSettings.id, true))
        await tx.insert(adminAuditLogs).values({ actorAccountId: repaired.id, action: 'instance.admin-repair', targetType: 'deployment', targetId: 'singleton', metadata: { existingAccount } })
        return repaired
      })
      await this.deployment.reload()
      return { ...account, isAdmin: true, totpEnabled: false }
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError({ code: 'account_exists', message: 'Account already exists', statusCode: 409 })
      throw error
    }
  }

  private hash(token: string): string {
    return createHmac('sha256', this.config.authSecret).update(token).digest('base64url')
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
