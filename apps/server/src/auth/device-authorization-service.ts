import { randomBytes, randomInt } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accounts, deploymentSettings, deviceAuthorizations } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { AuthService, DeviceSessionInput, SessionResult } from './service.js'
import { hashToken } from './web-session-service.js'

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface DeviceAuthorizationResult {
  deviceCode: string
  userCode: string
  expiresIn: number
  interval: number
}

export class DeviceAuthorizationService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly auth: AuthService,
  ) {}

  async create(input: DeviceSessionInput): Promise<DeviceAuthorizationResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const deviceCode = randomBytes(32).toString('base64url')
      const userCode = createUserCode()
      try {
        await this.database.db.insert(deviceAuthorizations).values({
          deviceCodeHash: hashToken(deviceCode),
          userCode,
          deviceId: input.deviceId,
          deviceName: input.deviceName.trim(),
          platform: input.platform,
          encryptionPublicKey: input.encryptionPublicKey ?? null,
          expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
        })
        return { deviceCode, userCode, expiresIn: 300, interval: 3 }
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 4) throw error
      }
    }
    throw new Error('Unable to allocate device authorization code')
  }

  async getByUserCode(userCode: string) {
    const [authorization] = await this.database.db.select({
      userCode: deviceAuthorizations.userCode,
      deviceId: deviceAuthorizations.deviceId,
      deviceName: deviceAuthorizations.deviceName,
      platform: deviceAuthorizations.platform,
      status: deviceAuthorizations.status,
      expiresAt: deviceAuthorizations.expiresAt,
    }).from(deviceAuthorizations).where(eq(deviceAuthorizations.userCode, normalizeUserCode(userCode))).limit(1)
    if (authorization === undefined) {
      throw new ApiError({ code: 'authorization_not_found', message: 'Device authorization was not found', statusCode: 404 })
    }
    return authorization
  }

  async approve(userCode: string, accountId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [account] = await tx.select({ credentialEpoch: accounts.credentialEpoch }).from(accounts).where(and(
        eq(accounts.id, accountId), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
      )).limit(1).for('update')
      if (account === undefined) throw new ApiError({ code: 'authorization_not_pending', message: 'Authorization is expired or no longer pending', statusCode: 409 })
      const [instanceAuth] = await tx.select({ epoch: deploymentSettings.instanceAuthEpoch }).from(deploymentSettings)
        .where(eq(deploymentSettings.id, true)).limit(1).for('update')
      if (instanceAuth === undefined) throw new Error('Instance authentication state is missing')
      const approvedAt = new Date()
      const approved = await tx.update(deviceAuthorizations).set({
        accountId,
        status: 'approved',
        approvedAt,
        approvedCredentialEpoch: account.credentialEpoch,
        approvedInstanceAuthEpoch: instanceAuth.epoch, approvedIssuedAt: approvedAt,
      }).where(and(
        eq(deviceAuthorizations.userCode, normalizeUserCode(userCode)),
        eq(deviceAuthorizations.status, 'pending'),
        gt(deviceAuthorizations.expiresAt, new Date()),
        isNull(deviceAuthorizations.consumedAt),
      )).returning({ id: deviceAuthorizations.id })
      if (approved.length === 0) {
        const [existing] = await tx.select({
          accountId: deviceAuthorizations.accountId,
          status: deviceAuthorizations.status,
          expiresAt: deviceAuthorizations.expiresAt,
        }).from(deviceAuthorizations).where(
          eq(deviceAuthorizations.userCode, normalizeUserCode(userCode)),
        ).limit(1)
        // The browser can repeat the approval while the NoteGen polling client
        // consumes it. Treat an approval already completed by this account as
        // idempotent instead of replacing the success screen with a 409.
        if (existing?.accountId === accountId && existing.status === 'approved'
          && existing.expiresAt > approvedAt) return
        throw new ApiError({ code: 'authorization_not_pending', message: 'Authorization is expired or no longer pending', statusCode: 409 })
      }
    })
  }

  async deny(userCode: string): Promise<void> {
    const denied = await this.database.db.update(deviceAuthorizations).set({ status: 'denied' }).where(and(
      eq(deviceAuthorizations.userCode, normalizeUserCode(userCode)),
      eq(deviceAuthorizations.status, 'pending'),
      gt(deviceAuthorizations.expiresAt, new Date()),
      isNull(deviceAuthorizations.consumedAt),
    )).returning({ id: deviceAuthorizations.id })
    if (denied.length === 0) {
      throw new ApiError({ code: 'authorization_not_pending', message: 'Authorization is expired or no longer pending', statusCode: 409 })
    }
  }

  async cancel(deviceCode: string): Promise<void> {
    await this.database.db.update(deviceAuthorizations).set({ status: 'denied' }).where(and(
      eq(deviceAuthorizations.deviceCodeHash, hashToken(deviceCode)),
      eq(deviceAuthorizations.status, 'pending'),
      isNull(deviceAuthorizations.consumedAt),
    ))
  }

  async exchange(deviceCode: string): Promise<SessionResult> {
    const consumedAt = new Date()
    const [authorization] = await this.database.db.update(deviceAuthorizations).set({ consumedAt }).where(and(
      eq(deviceAuthorizations.deviceCodeHash, hashToken(deviceCode)),
      eq(deviceAuthorizations.status, 'approved'),
      gt(deviceAuthorizations.expiresAt, consumedAt),
      isNull(deviceAuthorizations.consumedAt),
    )).returning({
      id: deviceAuthorizations.id,
      accountId: deviceAuthorizations.accountId,
      deviceId: deviceAuthorizations.deviceId,
      deviceName: deviceAuthorizations.deviceName,
      platform: deviceAuthorizations.platform,
      encryptionPublicKey: deviceAuthorizations.encryptionPublicKey,
      approvedCredentialEpoch: deviceAuthorizations.approvedCredentialEpoch,
      approvedInstanceAuthEpoch: deviceAuthorizations.approvedInstanceAuthEpoch,
      approvedIssuedAt: deviceAuthorizations.approvedIssuedAt,
    })
    if (authorization === undefined || authorization.accountId === null) {
      const [current] = await this.database.db.select({
        status: deviceAuthorizations.status,
        expiresAt: deviceAuthorizations.expiresAt,
        consumedAt: deviceAuthorizations.consumedAt,
      }).from(deviceAuthorizations).where(eq(deviceAuthorizations.deviceCodeHash, hashToken(deviceCode))).limit(1)
      if (current?.status === 'pending' && current.expiresAt > consumedAt) {
        throw new ApiError({ code: 'authorization_pending', message: 'Authorization is still pending', statusCode: 428, retryable: true })
      }
      if (current?.status === 'denied') {
        throw new ApiError({ code: 'authorization_denied', message: 'Authorization was denied', statusCode: 403 })
      }
      throw new ApiError({ code: 'authorization_expired', message: 'Authorization is expired or already used', statusCode: 401 })
    }
    if (authorization.approvedCredentialEpoch === null) {
      // Pre-epoch approvals cannot prove that their approving credentials are
      // still current after upgrade; require a fresh browser approval.
      await this.database.db.update(deviceAuthorizations).set({ status: 'denied' }).where(and(
        eq(deviceAuthorizations.id, authorization.id), eq(deviceAuthorizations.consumedAt, consumedAt),
      ))
      throw new ApiError({ code: 'authorization_expired', message: 'Authorization must be approved again', statusCode: 401 })
    }
    const [instanceAuth] = await this.database.db.select({ epoch: deploymentSettings.instanceAuthEpoch, tokenNotBefore: deploymentSettings.tokenNotBefore, enforced: deploymentSettings.authEpochEnforced })
      .from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
    if (instanceAuth === undefined || (instanceAuth.enforced && (
      authorization.approvedInstanceAuthEpoch === null || authorization.approvedIssuedAt === null ||
      authorization.approvedInstanceAuthEpoch !== instanceAuth.epoch || authorization.approvedIssuedAt < instanceAuth.tokenNotBefore
    ))) {
      await this.database.db.update(deviceAuthorizations).set({ status: 'denied' }).where(and(eq(deviceAuthorizations.id, authorization.id), eq(deviceAuthorizations.consumedAt, consumedAt)))
      throw new ApiError({ code: 'authorization_expired', message: 'Authorization must be approved again', statusCode: 401 })
    }
    try {
      return await this.auth.createDeviceSession(authorization.accountId, {
        deviceId: authorization.deviceId,
        deviceName: authorization.deviceName,
        platform: authorization.platform,
        ...(authorization.encryptionPublicKey === null
          ? {}
          : { encryptionPublicKey: authorization.encryptionPublicKey }),
      }, authorization.approvedCredentialEpoch?.toString())
    } catch (error) {
      await this.database.db.update(deviceAuthorizations).set({ consumedAt: null }).where(and(
        eq(deviceAuthorizations.id, authorization.id),
        eq(deviceAuthorizations.consumedAt, consumedAt),
      ))
      throw error
    }
  }
}

function createUserCode(): string {
  let value = ''
  for (let index = 0; index < 8; index += 1) {
    value += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]!
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`
}

function normalizeUserCode(value: string): string {
  const compact = value.toUpperCase().replaceAll(/[^A-Z0-9]/g, '')
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : value.toUpperCase()
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
