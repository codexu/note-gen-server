export type OperationEffect = 'allow' | 'deny' | 'challenge' | 'read-only' | 'throttle'

export interface PolicyDecision {
  effect: OperationEffect
  code?: string
  statusCode?: 403 | 409 | 423 | 429 | 503
  retryable?: boolean
  retryAfterSeconds?: number
  details?: Record<string, string | number | boolean>
}

export interface EffectiveLimits {
  storageBytes: bigint | null
  retainedStorageBytes: bigint | null
  devices: number | null
  workspaces: number | null
  monthlyIngressBytes: bigint | null
  monthlyEgressBytes: bigint | null
  enforcement: 'disabled' | 'observe' | 'soft' | 'hard'
  sourceRevision: string
}

/** Base implementation used until entitlement-backed limits are introduced. */
export class StaticEffectiveLimitsProvider {
  constructor(private readonly deploymentMode: 'hosted' | 'self-hosted') {}

  resolve(): { source: 'self-hosted-disabled' | 'hosted-static-default', limits: EffectiveLimits } {
    return {
      source: this.deploymentMode === 'self-hosted' ? 'self-hosted-disabled' : 'hosted-static-default',
      limits: {
        storageBytes: null, retainedStorageBytes: null, devices: null, workspaces: null,
        monthlyIngressBytes: null, monthlyEgressBytes: null, enforcement: 'disabled', sourceRevision: '0',
      },
    }
  }
}

/**
 * A small, deliberately boring common policy boundary. Domain plans add
 * restrictions and maintenance fencing here instead of teaching routes to
 * handcraft inconsistent status codes.
 */
export class OperationPolicy {
  allow(): PolicyDecision { return { effect: 'allow' } }

  deny(code: string, statusCode: 403 | 409 | 423 | 429 | 503, retryable = false, details?: Record<string, string | number | boolean>): PolicyDecision {
    return { effect: 'deny', code, statusCode, retryable, ...(details === undefined ? {} : { details }) }
  }
}
