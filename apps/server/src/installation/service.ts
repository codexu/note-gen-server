import argon2 from 'argon2'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import {
  accountIdentities,
  accountLoginClaims,
  accounts,
  adminAuditLogs,
  deploymentSettings,
  maintenanceState,
  staffPrincipals,
} from '../database/schema.js'
import { ApiError } from '../errors.js'
import { normalizeLoginKey } from '../identity/service.js'

export type InstallationDeploymentMode = 'self-hosted' | 'hosted'

export interface InstallationStatus {
  installationRequired: boolean
  activationPending: boolean
  serverName: string
}

export interface CompleteInstallationInput {
  serverName: string
  administrator: { login: string, password: string }
}

/** Owns the one-time transition from an empty migrated database to an installed instance. */
export class InstallationService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly installationOnly: boolean,
  ) {}

  async status(): Promise<InstallationStatus> {
    const [settings] = await this.database.db.select({
      runtimeConfiguration: deploymentSettings.runtimeConfiguration,
    }).from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
    const serverName = typeof settings?.runtimeConfiguration.serverName === 'string'
      ? settings.runtimeConfiguration.serverName
      : this.config.serverName
    return {
      installationRequired: settings === undefined,
      activationPending: settings !== undefined && this.installationOnly,
      serverName,
    }
  }

  async persistedSettings(): Promise<{
    deploymentMode: InstallationDeploymentMode
    registrationPolicy: 'bootstrap' | 'disabled' | 'invitation' | 'public'
  } | undefined> {
    const [settings] = await this.database.db.select({
      deploymentMode: deploymentSettings.deploymentMode,
      registrationPolicy: deploymentSettings.registrationPolicy,
    })
      .from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
    return settings
  }

  /** Converts the removed hosted/internal-test marker into the single
   * independent-instance model. This preserves accounts, registration policy,
   * runtime configuration, workspaces and all synchronized data. */
  async migrateLegacyOperationsInstallation(): Promise<boolean> {
    return await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-installation-mode-migration'))`)
      const [settings] = await tx.select().from(deploymentSettings)
        .where(eq(deploymentSettings.id, true)).limit(1).for('update')
      if (settings === undefined || settings.deploymentMode === 'self-hosted') return false
      const [activeAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
        eq(accounts.isAdmin, true), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
      )).limit(1)
      await tx.update(deploymentSettings).set({
        deploymentMode: 'self-hosted',
        selfHostedLifecycle: 'ready',
        adminRepairRequired: activeAdmin === undefined,
        initializedAt: settings.initializedAt ?? new Date(),
        initializedByAccountId: settings.initializedByAccountId ?? activeAdmin?.id ?? null,
        configurationRevision: sql`${deploymentSettings.configurationRevision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(deploymentSettings.id, true),
        eq(deploymentSettings.deploymentMode, settings.deploymentMode),
      ))
      return true
    })
  }

  async complete(input: CompleteInstallationInput): Promise<{
    serverName: string
    activationPending: true
  }> {
    if (!this.installationOnly) {
      throw new ApiError({ code: 'installation_not_available', message: 'Installation is not available', statusCode: 404 })
    }
    const serverName = input.serverName.trim()
    if (serverName.length < 1 || serverName.length > 100) {
      throw new ApiError({ code: 'installation_server_name_invalid', message: 'Server name is invalid', statusCode: 400 })
    }
    const passwordHash = await argon2.hash(input.administrator.password, { type: argon2.argon2id })

    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-installation'))`)
      const [existingSettings] = await tx.select({ id: deploymentSettings.id }).from(deploymentSettings)
        .where(eq(deploymentSettings.id, true)).limit(1)
      if (existingSettings !== undefined) {
        throw new ApiError({ code: 'installation_already_completed', message: 'Installation has already been completed', statusCode: 409 })
      }
      const [existingAccount] = await tx.select({ id: accounts.id }).from(accounts).limit(1)
      const [existingLegacyStaff] = await tx.select({ id: staffPrincipals.id }).from(staffPrincipals).limit(1)
      if (existingAccount !== undefined || existingLegacyStaff !== undefined) {
        throw new ApiError({
          code: 'installation_existing_data',
          message: 'Installation cannot run while account data already exists',
          statusCode: 409,
        })
      }

      const runtimeConfiguration = initialRuntimeConfiguration(this.config, serverName)
      const administrator = input.administrator
      const login = administrator.login.trim()
      const [created] = await tx.insert(accounts).values({
        login,
        passwordHash,
        isAdmin: true,
        identityState: 'active',
      }).returning({ id: accounts.id })
      if (created === undefined) throw new Error('Installation administrator insert returned no row')
      const normalizedLogin = normalizeLoginKey(login)
      const [identity] = await tx.insert(accountIdentities).values({
        accountId: created.id,
        kind: 'username',
        identifier: login,
        normalizedIdentifier: normalizedLogin,
        isPrimary: true,
      }).returning({ id: accountIdentities.id })
      if (identity === undefined) throw new Error('Installation identity insert returned no row')
      await tx.insert(accountLoginClaims).values({
        normalizedLoginKey: normalizedLogin,
        accountId: created.id,
        identityId: identity.id,
        kind: 'username',
      })
      await tx.insert(deploymentSettings).values({
        id: true,
        deploymentMode: 'self-hosted',
        registrationPolicy: 'disabled',
        selfHostedLifecycle: 'ready',
        initializedAt: new Date(),
        initializedByAccountId: created.id,
        runtimeConfiguration,
      })
      await tx.insert(maintenanceState).values({ id: true })
      await tx.insert(adminAuditLogs).values({
        actorAccountId: created.id,
        action: 'instance.web-installation-complete',
        targetType: 'deployment',
        targetId: 'singleton',
        metadata: { deploymentMode: 'self-hosted' },
      })
    })

    return { serverName, activationPending: true }
  }

}

function initialRuntimeConfiguration(config: AppConfig, serverName: string): Record<string, unknown> {
  return {
    serverName,
    maxObjectBytes: config.maxObjectBytes,
    maxBlobBytes: config.maxBlobBytes,
    changeRetentionDays: config.changeRetentionDays,
    versionRetentionDays: config.versionRetentionDays,
    tombstoneRetentionDays: config.tombstoneRetentionDays,
    mailDefaultLocale: config.mailDefaultLocale,
    pendingEmailVerificationDays: config.pendingEmailVerificationDays,
    accountDeletionCoolingOffDays: config.accountDeletionCoolingOffDays,
    accountDeletionRetentionDays: config.accountDeletionRetentionDays,
    mailDriver: 'disabled',
    mailFromAddress: '',
    mailFromName: 'NoteGen',
    mailReplyTo: '',
    smtpHost: '',
    smtpPort: 587,
    smtpTlsMode: 'starttls-required',
    smtpUsername: '',
    smtpPasswordCiphertext: '',
    smtpConnectTimeoutMs: 10_000,
    smtpCommandTimeoutMs: 15_000,
    smtpTlsRejectUnauthorized: true,
  }
}
