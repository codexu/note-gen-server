import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import {
  accountSubscriptions, billingAccountStates, billingPlanVersions, entitlementGrants,
} from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { StaffService } from '../staff/service.js'
import type { AccountServiceAudit } from '../audit/service.js'

export interface EffectiveEntitlements {
  schemaVersion: number
  revision: string
  source: 'free-default' | 'trial' | 'subscription' | 'manual-grant'
  validUntil: string | null
  features: Record<string, boolean>
  /** Numbers are strings to avoid losing bigint precision on the wire. Null means unlimited. */
  limits: Record<string, string | null>
}

export interface EntitlementDocument {
  features?: Record<string, boolean>
  limits?: Record<string, string | number | null>
}

const freeDefault: Required<EntitlementDocument> = { features: {}, limits: {} }

/**
 * Provider-neutral entitlement projection. It never calls a payment provider;
 * the later webhook/reconciliation slice is its only writer for subscriptions.
 */
export class EntitlementService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly staff?: StaffService,
    private readonly audit?: AccountServiceAudit,
  ) {}

  async getEffective(accountId: string, at = new Date()): Promise<EffectiveEntitlements> {
    const [state] = await this.database.db.select({ revision: billingAccountStates.revision })
      .from(billingAccountStates).where(eq(billingAccountStates.accountId, accountId)).limit(1)
    const grants = await this.database.db.select({
      schemaVersion: entitlementGrants.schemaVersion, entitlements: entitlementGrants.entitlements,
      expiresAt: entitlementGrants.expiresAt,
    }).from(entitlementGrants).where(and(
      eq(entitlementGrants.accountId, accountId), isNull(entitlementGrants.revokedAt),
      lte(entitlementGrants.startsAt, at), or(isNull(entitlementGrants.expiresAt), gt(entitlementGrants.expiresAt, at)),
    )).orderBy(asc(entitlementGrants.priority), asc(entitlementGrants.createdAt))

    const [subscription] = await this.database.db.select({
      status: accountSubscriptions.status, currentPeriodEnd: accountSubscriptions.currentPeriodEnd,
      graceEndsAt: accountSubscriptions.graceEndsAt, schemaVersion: billingPlanVersions.entitlementSchemaVersion,
      entitlements: billingPlanVersions.entitlements,
    }).from(accountSubscriptions).innerJoin(billingPlanVersions, eq(accountSubscriptions.planVersionId, billingPlanVersions.id))
      .where(and(eq(accountSubscriptions.accountId, accountId), eq(accountSubscriptions.isCurrent, true))).limit(1)

    let document = freeDefault
    let source: EffectiveEntitlements['source'] = 'free-default'
    let schemaVersion = 1
    let validUntil: Date | null = null
    let hasEntitledSource = false
    if (subscription !== undefined && isEntitledSubscription(subscription.status, subscription.currentPeriodEnd, subscription.graceEndsAt, at)) {
      document = parseDocument(subscription.entitlements)
      schemaVersion = subscription.schemaVersion
      source = subscription.status === 'trialing' ? 'trial' : 'subscription'
      validUntil = subscription.status === 'grace' ? subscription.graceEndsAt : subscription.currentPeriodEnd
      hasEntitledSource = true
    }
    for (const grant of grants) {
      document = mergeDocuments(document, parseDocument(grant.entitlements))
      schemaVersion = Math.max(schemaVersion, grant.schemaVersion)
      source = 'manual-grant'
      validUntil = hasEntitledSource ? laterOf(validUntil, grant.expiresAt) : grant.expiresAt
      hasEntitledSource = true
    }

    return {
      schemaVersion,
      revision: state?.revision.toString() ?? '0',
      source,
      validUntil: validUntil?.toISOString() ?? null,
      features: document.features,
      limits: normalizeLimits(document.limits),
    }
  }

  async listInternalPlans(at = new Date()): Promise<Array<{ planKey: string, version: number, displayName: string, currency: string, amountMinor: string, interval: 'month' | 'year', entitlementSchemaVersion: number }>> {
    if (this.config.deploymentMode !== 'hosted' || this.config.hostedReleaseStage !== 'internal-test') return []
    const plans = await this.database.db.select({
      planKey: billingPlanVersions.planKey, version: billingPlanVersions.version, displayName: billingPlanVersions.displayName,
      currency: billingPlanVersions.currency, amountMinor: billingPlanVersions.amountMinor, interval: billingPlanVersions.interval,
      entitlementSchemaVersion: billingPlanVersions.entitlementSchemaVersion,
    }).from(billingPlanVersions).where(and(lte(billingPlanVersions.activeFrom, at), isNull(billingPlanVersions.retiredAt)))
      .orderBy(asc(billingPlanVersions.planKey), asc(billingPlanVersions.version))
    return plans.map(plan => ({ ...plan, amountMinor: plan.amountMinor.toString() }))
  }

  /** Internal-test Staff grant path. Provider checkout/webhook state remains separate. */
  async createInternalGrant(input: {
    accountId: string
    sourceRef: string
    requestHash: string
    entitlements: EntitlementDocument
    expiresAt: Date
    priority?: number
    reason?: string
    actorStaffId?: string
    requestId?: string
  }): Promise<{ id: string, created: boolean }> {
    if (this.config.hostedReleaseStage !== 'internal-test' || this.config.deploymentMode !== 'hosted') {
      throw new ApiError({ code: 'billing_internal_test_only', message: 'Internal billing grants are not available in this deployment', statusCode: 403 })
    }
    if (input.actorStaffId === undefined || this.staff === undefined) {
      throw new ApiError({ code: 'billing_staff_authority_required', message: 'Staff billing authority is required', statusCode: 403 })
    }
    await this.staff.requirePermission(input.actorStaffId, 'billing.grant')
    if (input.expiresAt <= new Date()) throw new ApiError({ code: 'billing_grant_expiry_invalid', message: 'Internal grant expiry must be in the future', statusCode: 400 })
    const entitlements = parseDocument(input.entitlements)
    return await this.database.db.transaction(async (tx) => {
      await tx.insert(billingAccountStates).values({ accountId: input.accountId }).onConflictDoNothing()
      const [existing] = await tx.select({ id: entitlementGrants.id, requestHash: entitlementGrants.requestHash })
        .from(entitlementGrants).where(and(eq(entitlementGrants.accountId, input.accountId), eq(entitlementGrants.source, 'staff'), eq(entitlementGrants.sourceRef, input.sourceRef))).limit(1)
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) throw new ApiError({ code: 'idempotency_conflict', message: 'Grant source reference was reused with different input', statusCode: 409 })
        return { id: existing.id, created: false }
      }
      const [created] = await tx.insert(entitlementGrants).values({
        accountId: input.accountId, source: 'staff', sourceRef: input.sourceRef, requestHash: input.requestHash,
        schemaVersion: 1, entitlements, priority: input.priority ?? 100, expiresAt: input.expiresAt, reason: input.reason,
      }).returning({ id: entitlementGrants.id })
      if (created === undefined) throw new Error('Entitlement grant insert returned no row')
      await tx.update(billingAccountStates).set({ revision: sql`${billingAccountStates.revision} + 1`, updatedAt: new Date() })
        .where(eq(billingAccountStates.accountId, input.accountId))
      await this.audit?.recordInTransaction(tx, {
        actorType: 'staff', actorId: input.actorStaffId, action: 'billing.entitlement_grant.create',
        targetType: 'account', targetId: input.accountId, ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        metadata: { grantId: created.id, sourceRef: input.sourceRef, priority: input.priority ?? 100, expiresAt: input.expiresAt.toISOString() },
      })
      return { id: created.id, created: true }
    })
  }
}

/**
 * A provider outage or delayed webhook must not turn the last known active
 * state into an indefinite entitlement. Subscription rows are a snapshot, so
 * their entitlement is bounded by the provider-confirmed billing period (or
 * the separately confirmed grace deadline).
 */
function isEntitledSubscription(
  status: string,
  currentPeriodEnd: Date | null,
  graceEndsAt: Date | null,
  at: Date,
): boolean {
  if (status === 'grace') return graceEndsAt !== null && graceEndsAt > at
  return (status === 'trialing' || status === 'active')
    && currentPeriodEnd !== null && currentPeriodEnd > at
}

function parseDocument(value: Record<string, unknown> | EntitlementDocument): Required<EntitlementDocument> {
  const candidate = value as EntitlementDocument
  const features: Record<string, boolean> = {}
  const limits: Record<string, string | number | null> = {}
  for (const [key, enabled] of Object.entries(candidate.features ?? {})) {
    if (typeof enabled !== 'boolean') throw new ApiError({ code: 'billing_entitlement_invalid', message: `Feature ${key} must be boolean`, statusCode: 400 })
    features[key] = enabled
  }
  for (const [key, limit] of Object.entries(candidate.limits ?? {})) {
    if (limit !== null && !isLimitValue(limit)) throw new ApiError({ code: 'billing_entitlement_invalid', message: `Limit ${key} must be a non-negative integer or null`, statusCode: 400 })
    limits[key] = limit
  }
  return { features, limits }
}

function isLimitValue(value: string | number): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0
  return /^0$|^[1-9][0-9]*$/.test(value)
}

function normalizeLimits(limits: Record<string, string | number | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, value === null ? null : String(value)]))
}

function mergeDocuments(base: Required<EntitlementDocument>, override: Required<EntitlementDocument>): Required<EntitlementDocument> {
  const features = { ...base.features }
  for (const [key, value] of Object.entries(override.features)) features[key] = features[key] === true || value
  const limits = { ...base.limits }
  for (const [key, value] of Object.entries(override.limits)) limits[key] = widerLimit(limits[key], value)
  return { features, limits }
}

function widerLimit(left: string | number | null | undefined, right: string | number | null): string | number | null {
  if (left === undefined || left === null || right === null) return left === null || right === null ? null : right
  return BigInt(left) >= BigInt(right) ? left : right
}

function laterOf(left: Date | null, right: Date | null): Date | null {
  if (left === null || right === null) return null
  return left > right ? left : right
}
