import { randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { accounts, deploymentSettings, devicePairings } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { AuthService, DeviceSessionInput, SessionResult } from './service.js'
import { hashToken } from './web-session-service.js'

const PAIRING_LIFETIME_MS = 5 * 60 * 1_000

export type DevicePairingStatus = 'pending' | 'consumed' | 'expired'

export interface DevicePairingResult {
  id: string
  pairingToken: string
  expiresAt: Date
  expiresIn: number
}

export class DevicePairingService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly auth: AuthService,
  ) {}

  async create(accountId: string): Promise<DevicePairingResult> {
    const now = new Date()
    const pairingToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(now.getTime() + PAIRING_LIFETIME_MS)
    const pairing = await this.database.db.transaction(async (tx) => {
      const [account] = await tx.select({ credentialEpoch: accounts.credentialEpoch }).from(accounts).where(and(
        eq(accounts.id, accountId), isNull(accounts.suspendedAt), isNull(accounts.disabledAt),
      )).limit(1).for('update')
      if (account === undefined) throw new ApiError({ code: 'account_not_found', message: 'Account was not found', statusCode: 404 })
      const [instanceAuth] = await tx.select({ epoch: deploymentSettings.instanceAuthEpoch }).from(deploymentSettings)
        .where(eq(deploymentSettings.id, true)).limit(1).for('update')
      if (instanceAuth === undefined) throw new Error('Instance authentication state is missing')
      await tx.delete(devicePairings).where(and(
        eq(devicePairings.accountId, accountId),
        or(lt(devicePairings.expiresAt, now), lt(devicePairings.consumedAt, now)),
      ))
      const [created] = await tx.insert(devicePairings).values({
        tokenHash: hashToken(pairingToken), accountId, credentialEpoch: account.credentialEpoch,
        instanceAuthEpoch: instanceAuth.epoch, issuedAt: now, expiresAt,
      }).returning({ id: devicePairings.id })
      return created
    })
    if (pairing === undefined) throw new Error('Unable to create device pairing')
    return { id: pairing.id, pairingToken, expiresAt, expiresIn: PAIRING_LIFETIME_MS / 1_000 }
  }

  async getStatus(id: string, accountId: string): Promise<{ status: DevicePairingStatus, expiresAt: Date }> {
    const [pairing] = await this.database.db.select({
      expiresAt: devicePairings.expiresAt,
      consumedAt: devicePairings.consumedAt,
    }).from(devicePairings).where(and(
      eq(devicePairings.id, id),
      eq(devicePairings.accountId, accountId),
    )).limit(1)
    if (pairing === undefined) {
      throw new ApiError({ code: 'pairing_not_found', message: 'Device pairing was not found', statusCode: 404 })
    }
    return {
      status: pairing.consumedAt !== null ? 'consumed' : pairing.expiresAt <= new Date() ? 'expired' : 'pending',
      expiresAt: pairing.expiresAt,
    }
  }

  async cancel(id: string, accountId: string): Promise<void> {
    const removed = await this.database.db.delete(devicePairings).where(and(
      eq(devicePairings.id, id),
      eq(devicePairings.accountId, accountId),
      isNull(devicePairings.consumedAt),
    )).returning({ id: devicePairings.id })
    if (removed.length === 0) {
      throw new ApiError({ code: 'pairing_not_pending', message: 'Device pairing is expired or already used', statusCode: 409 })
    }
  }

  async exchange(pairingToken: string, input: DeviceSessionInput): Promise<SessionResult> {
    const consumedAt = new Date()
    const [pairing] = await this.database.db.update(devicePairings).set({ consumedAt }).where(and(
      eq(devicePairings.tokenHash, hashToken(pairingToken)),
      gt(devicePairings.expiresAt, consumedAt),
      isNull(devicePairings.consumedAt),
    )).returning({ id: devicePairings.id, accountId: devicePairings.accountId, credentialEpoch: devicePairings.credentialEpoch, instanceAuthEpoch: devicePairings.instanceAuthEpoch, issuedAt: devicePairings.issuedAt })
    if (pairing === undefined) {
      throw new ApiError({
        code: 'pairing_expired',
        message: 'Device pairing is expired, invalid, or already used',
        statusCode: 401,
      })
    }
    if (pairing.credentialEpoch === null) {
      await this.database.db.delete(devicePairings).where(and(eq(devicePairings.id, pairing.id), eq(devicePairings.consumedAt, consumedAt)))
      throw new ApiError({ code: 'pairing_expired', message: 'Pairing must be created again', statusCode: 401 })
    }
    const [instanceAuth] = await this.database.db.select({ epoch: deploymentSettings.instanceAuthEpoch, tokenNotBefore: deploymentSettings.tokenNotBefore, enforced: deploymentSettings.authEpochEnforced })
      .from(deploymentSettings).where(eq(deploymentSettings.id, true)).limit(1)
    if (instanceAuth === undefined || (instanceAuth.enforced && (
      pairing.instanceAuthEpoch === null || pairing.issuedAt === null ||
      pairing.instanceAuthEpoch !== instanceAuth.epoch || pairing.issuedAt < instanceAuth.tokenNotBefore
    ))) {
      await this.database.db.delete(devicePairings).where(and(eq(devicePairings.id, pairing.id), eq(devicePairings.consumedAt, consumedAt)))
      throw new ApiError({ code: 'pairing_expired', message: 'Pairing must be created again', statusCode: 401 })
    }
    try {
      await this.auth.getAccount(pairing.accountId)
      return await this.auth.createDeviceSession(pairing.accountId, input, pairing.credentialEpoch.toString())
    } catch (error) {
      await this.database.db.update(devicePairings).set({ consumedAt: null }).where(and(
        eq(devicePairings.id, pairing.id),
        eq(devicePairings.consumedAt, consumedAt),
      ))
      throw error
    }
  }
}
