import argon2 from 'argon2'
import { eq, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import {
  accountIdentities,
  accountLoginClaims,
  accounts,
  adminAuditLogs,
  deploymentSettings,
  staffPrincipals,
  staffRoleAssignments,
} from '../database/schema.js'
import { ApiError } from '../errors.js'
import { normalizeLoginKey } from '../identity/service.js'
import { normalizeLocalStaffLogin } from '../staff/service.js'

export type InstallationDeploymentMode = 'self-hosted' | 'hosted'
export type HostedRegistrationPolicy = 'disabled' | 'public'

export interface InstallationStatus {
  installationRequired: boolean
  activationPending: boolean
  deploymentMode: InstallationDeploymentMode | null
  serverName: string
}

export interface CompleteInstallationInput {
  deploymentMode: InstallationDeploymentMode
  serverName: string
  hostedRegistrationPolicy?: HostedRegistrationPolicy
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
      deploymentMode: deploymentSettings.deploymentMode,
      runtimeConfiguration: deploymentSettings.runtimeConfiguration,
    }).from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
    const serverName = typeof settings?.runtimeConfiguration.serverName === 'string'
      ? settings.runtimeConfiguration.serverName
      : this.config.serverName
    return {
      installationRequired: settings === undefined,
      activationPending: settings !== undefined && this.installationOnly,
      deploymentMode: settings?.deploymentMode ?? null,
      serverName,
    }
  }

  async persistedSettings(): Promise<{
    deploymentMode: InstallationDeploymentMode
    registrationPolicy: HostedRegistrationPolicy | 'bootstrap' | 'invitation'
  } | undefined> {
    const [settings] = await this.database.db.select({
      deploymentMode: deploymentSettings.deploymentMode,
      registrationPolicy: deploymentSettings.registrationPolicy,
    })
      .from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
    return settings
  }

  async complete(input: CompleteInstallationInput): Promise<{
    deploymentMode: InstallationDeploymentMode
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
      const [existingStaffPrincipal] = await tx.select({ id: staffPrincipals.id }).from(staffPrincipals).limit(1)
      if (existingAccount !== undefined || existingStaffPrincipal !== undefined) {
        throw new ApiError({
          code: 'installation_existing_data',
          message: 'Installation cannot run while account data already exists',
          statusCode: 409,
        })
      }

      const runtimeConfiguration = initialRuntimeConfiguration(this.config, serverName)
      if (input.deploymentMode === 'hosted') {
        const administrator = input.administrator
        const login = normalizeLocalStaffLogin(administrator.login)
        if (login.length < 1 || login.length > 200) {
          throw new ApiError({ code: 'installation_administrator_invalid', message: 'Administrator login is invalid', statusCode: 400 })
        }
        const [principal] = await tx.insert(staffPrincipals).values({
          externalIssuer: 'https://local.notegen.invalid',
          externalSubject: `local:${login}`,
          displayName: administrator.login.trim(),
          localLogin: login,
          localPasswordHash: passwordHash,
        }).returning({ id: staffPrincipals.id })
        if (principal === undefined) throw new Error('Installation Staff principal insert returned no row')
        await tx.insert(staffRoleAssignments).values({ staffId: principal.id, roleKey: 'platform-admin' })
        await tx.insert(deploymentSettings).values({
          id: true,
          deploymentMode: 'hosted',
          registrationPolicy: input.hostedRegistrationPolicy ?? 'disabled',
          selfHostedLifecycle: null,
          initializedAt: new Date(),
          runtimeConfiguration,
        })
        return
      }

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
      await tx.insert(adminAuditLogs).values({
        actorAccountId: created.id,
        action: 'instance.web-installation-complete',
        targetType: 'deployment',
        targetId: 'singleton',
        metadata: { deploymentMode: 'self-hosted' },
      })
    })

    return { deploymentMode: input.deploymentMode, serverName, activationPending: true }
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
