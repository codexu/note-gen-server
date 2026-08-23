import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AuthService } from '../auth/service.js'
import { requireAuth } from '../auth/http-auth.js'
import type { TokenService } from '../auth/tokens.js'
import type { DeploymentService } from '../deployment/service.js'
import { StaticEffectiveLimitsProvider } from '../policy/operation-policy.js'
import type { EntitlementService } from '../billing/service.js'
import type { UsageService } from '../usage/service.js'
import type { ComplianceService } from '../compliance/service.js'
import type { RiskService } from '../risk/service.js'
import type { MaintenanceCoordinator } from '../maintenance/coordinator.js'
import { NullableTimestamp } from './api-schemas.js'

export function createAccountContextRoutes(
  auth: AuthService,
  tokens: TokenService,
  deployment: DeploymentService,
  entitlements?: EntitlementService,
  usage?: UsageService,
  compliance?: ComplianceService,
  risk?: RiskService,
  usageHardEnforcementActive = false,
  maintenance?: MaintenanceCoordinator,
): FastifyPluginAsyncTypebox {
  return async function accountContextRoutes(app) {
    app.get('/v1/account/context', { schema: { response: { 200: Type.Object({
      account: Type.Object({ id: Type.String({ format: 'uuid' }), login: Type.String(), isAdmin: Type.Boolean(), totpEnabled: Type.Boolean() }),
      entitlements: Type.Object({ revision: Type.String(), features: Type.Record(Type.String(), Type.Boolean()), limits: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])) }),
      usage: Type.Object({ enforced: Type.Boolean(), revision: Type.String(), metrics: Type.Record(Type.String(), Type.String()), updatedAt: NullableTimestamp }),
      restrictions: Type.Array(Type.Unknown()),
      actions: Type.Record(Type.String(), Type.Object({ effect: Type.Union([Type.Literal('allow'), Type.Literal('deny')]), reasonCode: Type.String() })),
      accountContextRevision: Type.String(),
    }) } } }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      const account = await auth.getAccount(claims.accountId)
      const { limits } = new StaticEffectiveLimitsProvider(deployment.getState().deploymentMode).resolve()
      const effective = entitlements === undefined ? undefined : await entitlements.getEffective(claims.accountId)
      const usageSnapshot = usage === undefined ? undefined : await usage.getSnapshot(
        claims.accountId, (await maintenance?.getSnapshot())?.mode === 'normal',
      )
      const reacceptance = compliance === undefined ? [] : await compliance.requiredReacceptance(claims.accountId)
      const activeRiskRestrictions = risk === undefined ? [] : await risk.getActiveRestrictions(claims.accountId)
      const syncRiskRestriction = activeRiskRestrictions.find(restriction => restriction.scope === 'all' || restriction.scope === 'sync_write')
      const blobRiskRestriction = activeRiskRestrictions.find(restriction => restriction.scope === 'all' || restriction.scope === 'blob')
      const syncWriteEffect = reacceptance.length === 0 && syncRiskRestriction === undefined ? 'allow' as const : 'deny' as const
      const syncWriteReason = reacceptance.length > 0 ? 'policy_reacceptance_required'
        : syncRiskRestriction === undefined ? 'allowed' : 'risk_restriction'
      const blobWriteEffect = reacceptance.length === 0 && blobRiskRestriction === undefined ? 'allow' as const : 'deny' as const
      const blobWriteReason = reacceptance.length > 0 ? 'policy_reacceptance_required'
        : blobRiskRestriction === undefined ? 'allowed' : 'risk_restriction'
      const entitlementRevision = effective?.revision ?? limits.sourceRevision
      const usageRevision = usageSnapshot?.revision ?? '0'
      const accountContextRevision = [
        deployment.getState().configurationRevision, entitlementRevision, usageRevision,
        ...reacceptance.sort(),
        ...activeRiskRestrictions.map(restriction => `${restriction.scope}:${restriction.action}:${restriction.reasonCode}:${restriction.expiresAt}`).sort(),
      ].join(':')
      return {
        account,
        entitlements: effective === undefined
          ? { revision: entitlementRevision, features: {}, limits: {} }
          : { revision: entitlementRevision, features: effective.features, limits: effective.limits },
        usage: usageSnapshot === undefined
          ? { enforced: usageHardEnforcementActive, revision: '0', metrics: {}, updatedAt: null }
          : { enforced: usageHardEnforcementActive, ...usageSnapshot }, restrictions: [
            ...(reacceptance.length === 0 ? [] : [{ code: 'policy_reacceptance_required', policyDocumentIds: reacceptance }]),
            ...activeRiskRestrictions.map(restriction => ({ code: 'risk_restriction', ...restriction })),
        ],
        actions: {
          'sync.push': { effect: syncWriteEffect, reasonCode: syncWriteReason },
          'sync.pull': { effect: 'allow' as const, reasonCode: 'allowed' },
          'blob.upload': { effect: blobWriteEffect, reasonCode: blobWriteReason },
          'account.export': { effect: 'allow' as const, reasonCode: 'allowed' },
          'account.delete': { effect: 'allow' as const, reasonCode: 'allowed' },
        },
        accountContextRevision,
      }
    })
  }
}
