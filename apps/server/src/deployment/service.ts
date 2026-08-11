import { and, eq, isNull, sql } from 'drizzle-orm'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { accounts, adminAuditLogs, deploymentSettings } from '../database/schema.js'

export type RegistrationPolicy = 'bootstrap' | 'disabled' | 'invitation' | 'public'

export interface RuntimeConfiguration {
  serverName: string
  maxObjectBytes: number
  maxBlobBytes: number
  changeRetentionDays: number
  versionRetentionDays: number
  tombstoneRetentionDays: number
  mailDefaultLocale: 'en' | 'zh-CN'
  pendingEmailVerificationDays: number
  accountDeletionCoolingOffDays: number
  accountDeletionRetentionDays: number
  mailDriver: 'disabled' | 'smtp'
  mailFromAddress: string
  mailFromName: string
  mailReplyTo: string
  smtpHost: string
  smtpPort: number
  smtpTlsMode: 'starttls-required' | 'starttls' | 'tls' | 'none'
  smtpUsername: string
  smtpPasswordConfigured: boolean
  smtpConnectTimeoutMs: number
  smtpCommandTimeoutMs: number
  smtpTlsRejectUnauthorized: boolean
}

export interface DeploymentState {
  deploymentMode: 'hosted' | 'self-hosted'
  registrationPolicy: RegistrationPolicy
  selfHostedLifecycle: 'uninitialized' | 'ready' | null
  adminRepairRequired: boolean
  configurationRevision: string
  runtimeConfiguration: RuntimeConfiguration
}

/**
 * Reconciles the one-time environment-to-database migration before HTTP or workers
 * start. Once written, a deployment mode can never be changed by an env var.
 */
export class DeploymentService {
  private state: DeploymentState | undefined
  private unsafeLegacyHostedRegistration = false
  private configurationListening = false

  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
  ) {}

  async initialize(): Promise<void> {
    const state = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-deployment-settings'))`)
      const [existing] = await tx.select().from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
      if (existing !== undefined) {
        if (Object.keys(existing.runtimeConfiguration).length === 0) {
          const [migrated] = await tx.update(deploymentSettings).set({
            runtimeConfiguration: this.configurationForStorageFromEnvironment(),
            updatedAt: new Date(),
            configurationRevision: sql`${deploymentSettings.configurationRevision} + 1`,
          }).where(eq(deploymentSettings.id, true)).returning()
          if (migrated === undefined) throw new Error('Runtime configuration migration returned no row')
          return migrated
        }
        if (existing.deploymentMode === 'hosted'
          && this.config.deploymentMode === 'hosted'
          && this.config.hostedReleaseStage === 'internal-test'
          && existing.registrationPolicy !== this.config.hostedRegistrationPolicy) {
          const [updated] = await tx.update(deploymentSettings).set({
            registrationPolicy: this.config.hostedRegistrationPolicy,
            updatedAt: new Date(),
            configurationRevision: sql`${deploymentSettings.configurationRevision} + 1`,
          }).where(eq(deploymentSettings.id, true)).returning()
          if (updated !== undefined) return updated
        }
        if (existing.deploymentMode === 'self-hosted' && existing.selfHostedLifecycle === 'ready') {
          const [activeAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
            eq(accounts.isAdmin, true), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
          )).limit(1)
          if ((activeAdmin === undefined) !== existing.adminRepairRequired) {
            const [reconciled] = await tx.update(deploymentSettings).set({
              adminRepairRequired: activeAdmin === undefined, updatedAt: new Date(),
            }).where(eq(deploymentSettings.id, true)).returning()
            if (reconciled !== undefined) return reconciled
          }
        }
        return existing
      }

      const [account] = await tx.select({ id: accounts.id }).from(accounts).limit(1)
      const [activeAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
        eq(accounts.isAdmin, true), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
      )).limit(1)
      const isHosted = this.config.deploymentMode === 'hosted'
      const [created] = await tx.insert(deploymentSettings).values({
        id: true,
        deploymentMode: this.config.deploymentMode,
        // Hosted policy is control-plane-owned in production. Internal tests
        // may explicitly seed a policy without using the legacy open switch.
        registrationPolicy: isHosted ? this.config.hostedRegistrationPolicy : account === undefined ? 'bootstrap'
          : this.config.registrationMode === 'open' ? 'public' : 'disabled',
        selfHostedLifecycle: isHosted ? null : account === undefined ? 'uninitialized' : 'ready',
        adminRepairRequired: !isHosted && account !== undefined && activeAdmin === undefined,
        runtimeConfiguration: this.configurationForStorageFromEnvironment(),
      }).returning()
      if (created === undefined) throw new Error('Deployment settings insert returned no row')
      return created
    })

    this.unsafeLegacyHostedRegistration = state.deploymentMode === 'hosted'
      && this.config.registrationMode === 'open'
    this.state = this.toState(state)
    this.applyRuntimeConfiguration(this.state.runtimeConfiguration, state.runtimeConfiguration)
    if (!this.configurationListening) {
      await this.database.sql.listen('notegen_runtime_configuration', () => {
        void this.reload().catch(() => undefined)
      })
      this.configurationListening = true
    }
  }

  getState(): DeploymentState {
    if (this.state === undefined) throw new Error('DeploymentService was used before initialization')
    return this.state
  }

  async reload(): Promise<void> {
    const [state] = await this.database.db.select().from(deploymentSettings)
      .where(eq(deploymentSettings.id, true)).limit(1)
    if (state === undefined) throw new Error('Deployment settings are missing')
    this.state = this.toState(state)
    this.applyRuntimeConfiguration(this.state.runtimeConfiguration, state.runtimeConfiguration)
  }

  async updateRuntimeConfiguration(actorAccountId: string, configuration: RuntimeConfiguration, expectedRevision: string, smtpPassword?: string | null): Promise<boolean> {
    validateRuntimeConfiguration(configuration)
    const updated = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-runtime-configuration'))`)
      const [current] = await tx.select({ runtimeConfiguration: deploymentSettings.runtimeConfiguration })
        .from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1).for('update')
      if (current === undefined) throw new Error('Deployment settings are missing')
      const currentCiphertext = typeof current.runtimeConfiguration.smtpPasswordCiphertext === 'string'
        ? current.runtimeConfiguration.smtpPasswordCiphertext : ''
      const smtpPasswordCiphertext = smtpPassword === undefined ? currentCiphertext
        : smtpPassword === null || smtpPassword.length === 0 ? '' : this.encryptSecret(smtpPassword)
      const publicConfiguration: Record<string, unknown> = { ...configuration }
      delete publicConfiguration.smtpPasswordConfigured
      const storedConfiguration = { ...publicConfiguration, smtpPasswordCiphertext }
      const changed = await tx.update(deploymentSettings).set({
        runtimeConfiguration: storedConfiguration,
        configurationRevision: sql`${deploymentSettings.configurationRevision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(deploymentSettings.id, true),
        eq(deploymentSettings.configurationRevision, BigInt(expectedRevision)),
      )).returning({ revision: deploymentSettings.configurationRevision })
      if (changed.length === 0) return false
      await tx.insert(adminAuditLogs).values({
        actorAccountId,
        action: 'runtime-configuration.update',
        targetType: 'deployment',
        targetId: 'singleton',
        metadata: { fields: Object.keys(configuration) },
      })
      return true
    })
    await this.reload()
    if (!updated) return false
    await this.database.sql.notify('notegen_runtime_configuration', this.getState().configurationRevision)
    return true
  }

  getSafetyFailure(): string | undefined {
    const state = this.getState()
    if (state.deploymentMode !== this.config.deploymentMode) return 'deployment_mode_mismatch'
    if (this.unsafeLegacyHostedRegistration) return 'hosted_legacy_registration_open'
    return undefined
  }

  canRegisterNormally(): boolean {
    return this.getState().registrationPolicy === 'public'
  }

  canBootstrapAdministrator(): boolean {
    const state = this.getState()
    return state.deploymentMode === 'self-hosted'
      && state.registrationPolicy === 'bootstrap'
      && state.selfHostedLifecycle === 'uninitialized'
  }

  legacyRegistrationMode(): 'open' | 'closed' {
    return this.canRegisterNormally() ? 'open' : 'closed'
  }

  private toState(row: typeof deploymentSettings.$inferSelect): DeploymentState {
    return {
      deploymentMode: row.deploymentMode,
      registrationPolicy: row.registrationPolicy,
      selfHostedLifecycle: row.selfHostedLifecycle,
      adminRepairRequired: row.adminRepairRequired,
      configurationRevision: row.configurationRevision.toString(),
      runtimeConfiguration: normalizeRuntimeConfiguration(row.runtimeConfiguration, this.configurationFromEnvironment()),
    }
  }

  private configurationFromEnvironment(): RuntimeConfiguration {
    return {
      serverName: this.config.serverName,
      maxObjectBytes: this.config.maxObjectBytes,
      maxBlobBytes: this.config.maxBlobBytes,
      changeRetentionDays: this.config.changeRetentionDays,
      versionRetentionDays: this.config.versionRetentionDays,
      tombstoneRetentionDays: this.config.tombstoneRetentionDays,
      mailDefaultLocale: this.config.mailDefaultLocale,
      pendingEmailVerificationDays: this.config.pendingEmailVerificationDays,
      accountDeletionCoolingOffDays: this.config.accountDeletionCoolingOffDays,
      accountDeletionRetentionDays: this.config.accountDeletionRetentionDays,
      mailDriver: this.config.mailDriver,
      mailFromAddress: this.config.mailFromAddress,
      mailFromName: this.config.mailFromName,
      mailReplyTo: this.config.mailReplyTo,
      smtpHost: this.config.smtpHost,
      smtpPort: this.config.smtpPort,
      smtpTlsMode: this.config.smtpTlsMode,
      smtpUsername: this.config.smtpUsername,
      smtpPasswordConfigured: this.config.smtpPassword.length > 0,
      smtpConnectTimeoutMs: this.config.smtpConnectTimeoutMs,
      smtpCommandTimeoutMs: this.config.smtpCommandTimeoutMs,
      smtpTlsRejectUnauthorized: this.config.smtpTlsRejectUnauthorized,
    }
  }

  private configurationForStorageFromEnvironment(): Record<string, unknown> {
    const configuration = this.configurationFromEnvironment()
    const publicConfiguration: Record<string, unknown> = { ...configuration }
    delete publicConfiguration.smtpPasswordConfigured
    return {
      ...publicConfiguration,
      smtpPasswordCiphertext: this.config.smtpPassword.length === 0 ? '' : this.encryptSecret(this.config.smtpPassword),
    }
  }

  private applyRuntimeConfiguration(configuration: RuntimeConfiguration, stored: Record<string, unknown>): void {
    if (configuration.maxBlobBytes > this.config.blobPartBytes * 10_000) {
      throw new Error('Invalid runtime configuration: maxBlobBytes exceeds the 10000-part upload limit')
    }
    const smtpPasswordCiphertext = typeof stored.smtpPasswordCiphertext === 'string' ? stored.smtpPasswordCiphertext : ''
    const smtpPassword = smtpPasswordCiphertext.length === 0 ? '' : this.decryptSecret(smtpPasswordCiphertext)
    if (configuration.mailDriver === 'smtp' && (
      configuration.smtpHost.length === 0 || !isEmailAddress(configuration.mailFromAddress)
      || ((configuration.smtpUsername.length === 0) !== (smtpPassword.length === 0))
      || (configuration.mailReplyTo.length > 0 && !isEmailAddress(configuration.mailReplyTo))
    )) throw new Error('Invalid runtime configuration: incomplete SMTP settings')
    Object.assign(this.config as unknown as Record<string, unknown>, configuration, {
      smtpPassword,
    })
  }

  private encryptSecret(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.secretKey(), iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`
  }

  private decryptSecret(value: string): string {
    const [iv, encrypted, tag, ...extra] = value.split('.')
    if (!iv || !encrypted || !tag || extra.length > 0) throw new Error('Invalid encrypted SMTP password')
    const decipher = createDecipheriv('aes-256-gcm', this.secretKey(), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
  }

  private secretKey(): Buffer {
    return createHash('sha256').update(this.config.authSecret).update('runtime-configuration-secret-v1').digest()
  }
}

function normalizeRuntimeConfiguration(value: Record<string, unknown>, fallback: RuntimeConfiguration): RuntimeConfiguration {
  const configuration = {
    ...fallback,
    ...value,
    smtpPasswordConfigured: typeof value.smtpPasswordCiphertext === 'string' && value.smtpPasswordCiphertext.length > 0,
  } as RuntimeConfiguration
  validateRuntimeConfiguration(configuration)
  return configuration
}

function validateRuntimeConfiguration(value: RuntimeConfiguration): void {
  const integerInRange = (input: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(input) && input >= minimum && input <= maximum
  if (typeof value.serverName !== 'string' || value.serverName.trim().length < 1 || value.serverName.length > 100) {
    throw new Error('Invalid runtime configuration: serverName')
  }
  if (!integerInRange(value.maxObjectBytes, 1, 64 * 1024 * 1024)) throw new Error('Invalid runtime configuration: maxObjectBytes')
  if (!integerInRange(value.maxBlobBytes, 1, 1024 * 1024 * 1024 * 1024)) throw new Error('Invalid runtime configuration: maxBlobBytes')
  if (!integerInRange(value.changeRetentionDays, 1, 3650)) throw new Error('Invalid runtime configuration: changeRetentionDays')
  if (!integerInRange(value.versionRetentionDays, value.changeRetentionDays, 3650)) throw new Error('Invalid runtime configuration: versionRetentionDays')
  if (!integerInRange(value.tombstoneRetentionDays, 1, 3650)) throw new Error('Invalid runtime configuration: tombstoneRetentionDays')
  if (value.mailDefaultLocale !== 'en' && value.mailDefaultLocale !== 'zh-CN') throw new Error('Invalid runtime configuration: mailDefaultLocale')
  if (!integerInRange(value.pendingEmailVerificationDays, 1, 90)) throw new Error('Invalid runtime configuration: pendingEmailVerificationDays')
  if (!integerInRange(value.accountDeletionCoolingOffDays, 1, 365)) throw new Error('Invalid runtime configuration: accountDeletionCoolingOffDays')
  if (!integerInRange(value.accountDeletionRetentionDays, value.accountDeletionCoolingOffDays, 3650)) throw new Error('Invalid runtime configuration: accountDeletionRetentionDays')
  if (value.mailDriver !== 'disabled' && value.mailDriver !== 'smtp') throw new Error('Invalid runtime configuration: mailDriver')
  if (typeof value.mailFromAddress !== 'string' || value.mailFromAddress.length > 320) throw new Error('Invalid runtime configuration: mailFromAddress')
  if (typeof value.mailFromName !== 'string' || value.mailFromName.length > 200) throw new Error('Invalid runtime configuration: mailFromName')
  if (typeof value.mailReplyTo !== 'string' || value.mailReplyTo.length > 320) throw new Error('Invalid runtime configuration: mailReplyTo')
  if (typeof value.smtpHost !== 'string' || value.smtpHost.length > 255) throw new Error('Invalid runtime configuration: smtpHost')
  if (!integerInRange(value.smtpPort, 1, 65_535)) throw new Error('Invalid runtime configuration: smtpPort')
  if (!['starttls-required', 'starttls', 'tls', 'none'].includes(value.smtpTlsMode)) throw new Error('Invalid runtime configuration: smtpTlsMode')
  if (typeof value.smtpUsername !== 'string' || value.smtpUsername.length > 500) throw new Error('Invalid runtime configuration: smtpUsername')
  if (typeof value.smtpPasswordConfigured !== 'boolean') throw new Error('Invalid runtime configuration: smtpPasswordConfigured')
  if (!integerInRange(value.smtpConnectTimeoutMs, 1_000, 120_000)) throw new Error('Invalid runtime configuration: smtpConnectTimeoutMs')
  if (!integerInRange(value.smtpCommandTimeoutMs, 1_000, 120_000)) throw new Error('Invalid runtime configuration: smtpCommandTimeoutMs')
  if (typeof value.smtpTlsRejectUnauthorized !== 'boolean') throw new Error('Invalid runtime configuration: smtpTlsRejectUnauthorized')
}

function isEmailAddress(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
