import argon2 from 'argon2'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accounts, devices, refreshTokens, workspaces } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { TokenService } from './tokens.js'
import type { TotpService } from './totp-service.js'

export interface SessionInput {
  login: string
  password: string
  deviceId: string
  deviceName: string
  platform: string
  encryptionPublicKey?: string
  totpCode?: string
}

export interface SessionResult {
  accountId: string
  deviceId: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
}

export interface DeviceSessionInput {
  deviceId: string
  deviceName: string
  platform: string
  encryptionPublicKey?: string
}

export interface AccountIdentity {
  id: string
  login: string
  isAdmin: boolean
  totpEnabled: boolean
}

export class AuthService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
  ) {}

  async registerAccount(login: string, password: string): Promise<AccountIdentity> {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    try {
      const account = await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-admin-bootstrap'))`)
        const [existingAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
          eq(accounts.isAdmin, true),
          isNull(accounts.suspendedAt),
          isNull(accounts.disabledAt),
        )).limit(1)
        const [created] = await tx.insert(accounts).values({
          login: login.trim(),
          passwordHash,
          isAdmin: existingAdmin === undefined,
        }).returning({ id: accounts.id, login: accounts.login, isAdmin: accounts.isAdmin })
        return created
      })
      if (account === undefined) throw new Error('Account insert returned no row')
      return { ...account, totpEnabled: false }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError({ code: 'account_exists', message: 'Account already exists', statusCode: 409 })
      }
      throw error
    }
  }

  async authenticateAccount(login: string, password: string, totpCode?: string): Promise<AccountIdentity> {
    const [account] = await this.database.db.select({
      id: accounts.id,
      login: accounts.login,
      isAdmin: accounts.isAdmin,
      passwordHash: accounts.passwordHash,
      totpSecret: accounts.totpSecret,
      totpEnabledAt: accounts.totpEnabledAt,
    }).from(accounts).where(and(
      sql`lower(${accounts.login}) = lower(${login.trim()})`,
      isNull(accounts.suspendedAt),
      isNull(accounts.disabledAt),
    )).limit(1)
    if (account === undefined || !await argon2.verify(account.passwordHash, password)) {
      throw new ApiError({ code: 'credentials_invalid', message: 'Login or password is invalid', statusCode: 401 })
    }
    if (account.totpEnabledAt !== null) {
      if (account.totpSecret === null || totpCode === undefined
        || !this.totp.verify(this.totp.decrypt(account.totpSecret), totpCode)) {
        throw new ApiError({ code: 'totp_required', message: 'A valid two-factor authentication code is required', statusCode: 401 })
      }
    }
    return { id: account.id, login: account.login, isAdmin: account.isAdmin, totpEnabled: account.totpEnabledAt !== null }
  }

  async getAccount(accountId: string): Promise<AccountIdentity> {
    const [account] = await this.database.db.select({
      id: accounts.id,
      login: accounts.login,
      isAdmin: accounts.isAdmin,
      totpEnabledAt: accounts.totpEnabledAt,
    }).from(accounts).where(and(
      eq(accounts.id, accountId),
      isNull(accounts.suspendedAt),
      isNull(accounts.disabledAt),
    )).limit(1)
    if (account === undefined) {
      throw new ApiError({ code: 'account_not_found', message: 'Account was not found', statusCode: 404 })
    }
    return { id: account.id, login: account.login, isAdmin: account.isAdmin, totpEnabled: account.totpEnabledAt !== null }
  }

  async createDeviceSession(accountId: string, input: DeviceSessionInput): Promise<SessionResult> {
    await this.database.db.transaction(async (tx) => {
      const [existingDevice] = await tx.select({
        accountId: devices.accountId,
        encryptionPublicKey: devices.encryptionPublicKey,
      }).from(devices).where(eq(devices.id, input.deviceId)).limit(1)
      if (existingDevice !== undefined && existingDevice.accountId !== accountId) {
        throw new ApiError({ code: 'device_conflict', message: 'Device belongs to another account', statusCode: 409 })
      }
      if (existingDevice?.encryptionPublicKey !== null && existingDevice?.encryptionPublicKey !== undefined
        && input.encryptionPublicKey !== undefined
        && input.encryptionPublicKey !== existingDevice.encryptionPublicKey) {
        throw new ApiError({
          code: 'device_key_conflict',
          message: 'Device ID is already bound to another encryption key',
          statusCode: 409,
        })
      }
      await tx.insert(devices).values({
        id: input.deviceId,
        accountId,
        name: input.deviceName,
        platform: input.platform,
        encryptionPublicKey: input.encryptionPublicKey ?? null,
      }).onConflictDoUpdate({
        target: devices.id,
        set: {
          name: input.deviceName,
          platform: input.platform,
          ...(input.encryptionPublicKey === undefined ? {} : { encryptionPublicKey: input.encryptionPublicKey }),
          lastSeenAt: new Date(),
          revokedAt: null,
          updatedAt: new Date(),
        },
      })
    })
    return this.#issueSession(accountId, input.deviceId)
  }

  async register(input: SessionInput): Promise<SessionResult> {
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id })

    let accountId: string
    try {
      accountId = await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-admin-bootstrap'))`)
        const [existingAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
          eq(accounts.isAdmin, true),
          isNull(accounts.suspendedAt),
          isNull(accounts.disabledAt),
        )).limit(1)
        const [account] = await tx.insert(accounts).values({
          login: input.login.trim(),
          passwordHash,
          isAdmin: existingAdmin === undefined,
        }).returning({ id: accounts.id })
        if (account === undefined) throw new Error('Account insert returned no row')

        await tx.insert(devices).values({
          id: input.deviceId,
          accountId: account.id,
          name: input.deviceName,
          platform: input.platform,
          encryptionPublicKey: input.encryptionPublicKey ?? null,
        })
        return account.id
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError({ code: 'account_exists', message: 'Account or device already exists', statusCode: 409 })
      }
      throw error
    }

    return this.#issueSession(accountId, input.deviceId)
  }

  async login(input: SessionInput): Promise<SessionResult> {
    const account = await this.authenticateAccount(input.login, input.password, input.totpCode)
    return this.createDeviceSession(account.id, input)
  }

  async refresh(token: string, deviceId: string): Promise<SessionResult> {
    const tokenHash = this.tokens.hashRefreshToken(token)
    const now = new Date()

    const result = await this.database.db.transaction(async (tx) => {
      const [stored] = await tx.select({
        id: refreshTokens.id,
        accountId: refreshTokens.accountId,
        deviceId: refreshTokens.deviceId,
        expiresAt: refreshTokens.expiresAt,
        rotatedAt: refreshTokens.rotatedAt,
        revokedAt: refreshTokens.revokedAt,
        deviceRevokedAt: devices.revokedAt,
      }).from(refreshTokens).innerJoin(devices, and(
        eq(devices.id, refreshTokens.deviceId),
      )).where(and(
        eq(refreshTokens.tokenHash, tokenHash),
        eq(refreshTokens.deviceId, deviceId),
      )).limit(1).for('update')

      if (stored === undefined || stored.revokedAt !== null || stored.deviceRevokedAt !== null
        || stored.expiresAt <= now) {
        throw new ApiError({ code: 'refresh_token_invalid', message: 'Refresh token is invalid or expired', statusCode: 401 })
      }
      if (stored.rotatedAt !== null) {
        await tx.update(devices).set({ revokedAt: now, updatedAt: now }).where(eq(devices.id, deviceId))
        await tx.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.deviceId, deviceId))
        return { compromised: true as const, accountId: stored.accountId, deviceId: stored.deviceId }
      }

      await tx.update(refreshTokens).set({ rotatedAt: now }).where(eq(refreshTokens.id, stored.id))
      const nextRefreshToken = this.tokens.createRefreshToken()
      await tx.insert(refreshTokens).values({
        accountId: stored.accountId,
        deviceId: stored.deviceId,
        tokenHash: this.tokens.hashRefreshToken(nextRefreshToken),
        expiresAt: addDays(now, 30),
      })
      await tx.update(devices).set({ lastSeenAt: now, updatedAt: now }).where(eq(devices.id, deviceId))
      return {
        compromised: false as const,
        accountId: stored.accountId,
        deviceId: stored.deviceId,
        refreshToken: nextRefreshToken,
      }
    })

    if (result.compromised) {
      throw new ApiError({
        code: 'refresh_token_reused',
        message: 'Refresh token reuse detected; the device session was revoked',
        statusCode: 401,
      })
    }

    return {
      accountId: result.accountId,
      deviceId: result.deviceId,
      refreshToken: result.refreshToken,
      accessToken: await this.tokens.signAccessToken({ accountId: result.accountId, deviceId: result.deviceId }),
      accessTokenExpiresIn: 900,
    }
  }

  async logout(token: string, deviceId: string): Promise<void> {
    await this.database.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(
      eq(refreshTokens.tokenHash, this.tokens.hashRefreshToken(token)),
      eq(refreshTokens.deviceId, deviceId),
    ))
  }

  async assertDeviceActive(accountId: string, deviceId: string): Promise<void> {
    const [device] = await this.database.db.select({ id: devices.id }).from(devices).innerJoin(
      accounts, eq(accounts.id, devices.accountId),
    ).where(and(
      eq(devices.id, deviceId), eq(devices.accountId, accountId),
      isNull(devices.revokedAt), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
    )).limit(1)
    if (device === undefined) {
      throw new ApiError({ code: 'device_revoked', message: 'Device session has been revoked', statusCode: 401 })
    }
  }

  async changePassword(
    accountId: string,
    deviceId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<SessionResult> {
    const [account] = await this.database.db.select({ passwordHash: accounts.passwordHash }).from(accounts)
      .where(and(
        eq(accounts.id, accountId), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
      )).limit(1)
    if (account === undefined || !await argon2.verify(account.passwordHash, currentPassword)) {
      throw new ApiError({ code: 'credentials_invalid', message: 'Current password is invalid', statusCode: 401 })
    }
    if (await argon2.verify(account.passwordHash, newPassword)) {
      throw new ApiError({ code: 'password_unchanged', message: 'New password must be different', statusCode: 400 })
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id })
    await this.database.db.transaction(async (tx) => {
      await tx.update(accounts).set({ passwordHash, updatedAt: new Date() }).where(eq(accounts.id, accountId))
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.accountId, accountId))
      const activeDevice = await tx.update(devices).set({ updatedAt: new Date() }).where(and(
        eq(devices.id, deviceId), eq(devices.accountId, accountId), isNull(devices.revokedAt),
      )).returning({ id: devices.id })
      if (activeDevice.length === 0) {
        throw new ApiError({ code: 'device_revoked', message: 'Device session has been revoked', statusCode: 401 })
      }
    })
    return this.#issueSession(accountId, deviceId)
  }

  async changeWebPassword(accountId: string, currentPassword: string, newPassword: string): Promise<void> {
    const [account] = await this.database.db.select({ passwordHash: accounts.passwordHash }).from(accounts)
      .where(and(
        eq(accounts.id, accountId), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
      )).limit(1)
    if (account === undefined || !await argon2.verify(account.passwordHash, currentPassword)) {
      throw new ApiError({ code: 'credentials_invalid', message: 'Current password is invalid', statusCode: 401 })
    }
    if (await argon2.verify(account.passwordHash, newPassword)) {
      throw new ApiError({ code: 'password_unchanged', message: 'New password must be different', statusCode: 400 })
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id })
    await this.database.db.transaction(async (tx) => {
      await tx.update(accounts).set({ passwordHash, updatedAt: new Date() }).where(eq(accounts.id, accountId))
      const now = new Date()
      await tx.update(devices).set({ revokedAt: now, updatedAt: now }).where(and(
        eq(devices.accountId, accountId), isNull(devices.revokedAt),
      ))
      await tx.update(refreshTokens).set({ revokedAt: now }).where(and(
        eq(refreshTokens.accountId, accountId), isNull(refreshTokens.revokedAt),
      ))
    })
  }

  async beginTotpSetup(accountId: string, currentPassword: string): Promise<{ secret: string, uri: string }> {
    const account = await this.#verifyAccountPassword(accountId, currentPassword)
    const secret = this.totp.createSecret()
    await this.database.db.update(accounts).set({
      totpSecret: this.totp.encrypt(secret), totpEnabledAt: null, updatedAt: new Date(),
    }).where(eq(accounts.id, accountId))
    return { secret, uri: this.totp.uri(account.login, secret) }
  }

  async enableTotp(accountId: string, code: string): Promise<void> {
    const [account] = await this.database.db.select({ secret: accounts.totpSecret }).from(accounts)
      .where(and(eq(accounts.id, accountId), isNull(accounts.disabledAt), isNull(accounts.suspendedAt))).limit(1)
    if (account?.secret === null || account?.secret === undefined
      || !this.totp.verify(this.totp.decrypt(account.secret), code)) {
      throw new ApiError({ code: 'totp_invalid', message: 'Two-factor authentication code is invalid', statusCode: 401 })
    }
    await this.database.db.update(accounts).set({ totpEnabledAt: new Date(), updatedAt: new Date() })
      .where(eq(accounts.id, accountId))
  }

  async disableTotp(accountId: string, currentPassword: string, code: string): Promise<void> {
    await this.#verifyAccountPassword(accountId, currentPassword)
    const [account] = await this.database.db.select({ secret: accounts.totpSecret }).from(accounts)
      .where(eq(accounts.id, accountId)).limit(1)
    if (account?.secret === null || account?.secret === undefined
      || !this.totp.verify(this.totp.decrypt(account.secret), code)) {
      throw new ApiError({ code: 'totp_invalid', message: 'Two-factor authentication code is invalid', statusCode: 401 })
    }
    await this.database.db.update(accounts).set({ totpSecret: null, totpEnabledAt: null, updatedAt: new Date() })
      .where(eq(accounts.id, accountId))
  }

  async #verifyAccountPassword(accountId: string, password: string): Promise<{ login: string }> {
    const [account] = await this.database.db.select({
      login: accounts.login, passwordHash: accounts.passwordHash,
    }).from(accounts).where(and(
      eq(accounts.id, accountId), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
    )).limit(1)
    if (account === undefined || !await argon2.verify(account.passwordHash, password)) {
      throw new ApiError({ code: 'credentials_invalid', message: 'Current password is invalid', statusCode: 401 })
    }
    return { login: account.login }
  }

  async requestAccountDeletion(accountId: string, password: string, retentionDays: number): Promise<Date> {
    const [account] = await this.database.db.select({ passwordHash: accounts.passwordHash }).from(accounts)
      .where(and(
        eq(accounts.id, accountId), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
      )).limit(1)
    if (account === undefined || !await argon2.verify(account.passwordHash, password)) {
      throw new ApiError({ code: 'credentials_invalid', message: 'Password is invalid', statusCode: 401 })
    }
    const requestedAt = new Date()
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('notegen-admin-role'))`)
      const [deletingAccount] = await tx.select({ isAdmin: accounts.isAdmin }).from(accounts)
        .where(eq(accounts.id, accountId)).limit(1).for('update')
      if (deletingAccount?.isAdmin) {
        const [otherAdmin] = await tx.select({ id: accounts.id }).from(accounts).where(and(
          eq(accounts.isAdmin, true),
          ne(accounts.id, accountId),
          isNull(accounts.suspendedAt),
          isNull(accounts.disabledAt),
        )).limit(1)
        if (otherAdmin === undefined) {
          throw new ApiError({
            code: 'last_admin_delete_forbidden',
            message: 'The last active administrator cannot request account deletion',
            statusCode: 409,
          })
        }
      }
      await tx.update(accounts).set({ disabledAt: requestedAt, updatedAt: requestedAt })
        .where(eq(accounts.id, accountId))
      await tx.update(devices).set({ revokedAt: requestedAt, updatedAt: requestedAt })
        .where(eq(devices.accountId, accountId))
      await tx.update(refreshTokens).set({ revokedAt: requestedAt }).where(eq(refreshTokens.accountId, accountId))
      await tx.update(workspaces).set({ deletedAt: requestedAt, updatedAt: requestedAt })
        .where(eq(workspaces.accountId, accountId))
    })
    return addDays(requestedAt, retentionDays)
  }

  async revokeDevice(accountId: string, deviceId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.update(devices).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(
        eq(devices.id, deviceId), eq(devices.accountId, accountId),
      ))
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(
        eq(refreshTokens.deviceId, deviceId), eq(refreshTokens.accountId, accountId),
      ))
    })
  }

  async renameDevice(accountId: string, deviceId: string, name: string): Promise<void> {
    const renamed = await this.database.db.update(devices).set({
      name: name.trim(), updatedAt: new Date(),
    }).where(and(eq(devices.id, deviceId), eq(devices.accountId, accountId)))
      .returning({ id: devices.id })
    if (renamed.length === 0) {
      throw new ApiError({ code: 'device_not_found', message: 'Device not found', statusCode: 404 })
    }
  }

  async listDevices(accountId: string, currentDeviceId?: string) {
    const rows = await this.database.db.select({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      encryptionPublicKey: devices.encryptionPublicKey,
      lastSeenAt: devices.lastSeenAt,
      createdAt: devices.createdAt,
      revokedAt: devices.revokedAt,
    }).from(devices).where(eq(devices.accountId, accountId)).orderBy(devices.createdAt)
    return rows.map((device) => ({ ...device, current: currentDeviceId !== undefined && device.id === currentDeviceId }))
  }

  async #issueSession(accountId: string, deviceId: string): Promise<SessionResult> {
    const refreshToken = this.tokens.createRefreshToken()
    await this.database.db.insert(refreshTokens).values({
      accountId,
      deviceId,
      tokenHash: this.tokens.hashRefreshToken(refreshToken),
      expiresAt: addDays(new Date(), 30),
    })
    return {
      accountId,
      deviceId,
      accessToken: await this.tokens.signAccessToken({ accountId, deviceId }),
      refreshToken,
      accessTokenExpiresIn: 900,
    }
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  const visited = new Set<object>()
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current)
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}
