import type { AppConfig } from '../config.js'
import type { DeploymentService } from './service.js'

export const capabilityIds = [
  'identity.email', 'identity.emailVerification', 'identity.passwordReset',
  'registration.invitation', 'registration.public', 'risk.advanced', 'usage.enforcement',
  'billing.subscription', 'compliance.requests', 'support.cases', 'operations.webBootstrap',
  'mail.delivery', 'operations.smtpAdmin', 'operations.unifiedBackup',
  'operations.upgradeAssistant', 'operations.preserveRestore',
] as const

export type CapabilityId = typeof capabilityIds[number]
type DeploymentMode = 'hosted' | 'self-hosted'

export interface CapabilityExplanation {
  id: CapabilityId
  available: boolean
  deploymentMode: DeploymentMode
  requestedBy: 'enabled_override' | 'disabled_override' | 'default' | 'lifecycle'
  reasons: string[]
  dependencies: Array<{ id: CapabilityId, available: boolean }>
}

interface CapabilityDefinition {
  readonly id: CapabilityId
  readonly supportedModes: readonly DeploymentMode[]
  readonly defaultByMode: Readonly<Record<DeploymentMode, boolean>>
  readonly requires: readonly CapabilityId[]
  readonly overrideable: boolean
  readonly availabilitySource: 'configuration' | 'lifecycle' | 'registration-policy'
}

const both: readonly DeploymentMode[] = ['hosted', 'self-hosted']
const disabled = { hosted: false, 'self-hosted': false } as const

const definitions: readonly CapabilityDefinition[] = [
  { id: 'identity.email', supportedModes: both, defaultByMode: disabled, requires: ['mail.delivery'], overrideable: true, availabilitySource: 'configuration' },
  { id: 'identity.emailVerification', supportedModes: both, defaultByMode: disabled, requires: ['identity.email'], overrideable: true, availabilitySource: 'configuration' },
  { id: 'identity.passwordReset', supportedModes: both, defaultByMode: disabled, requires: ['identity.email'], overrideable: true, availabilitySource: 'configuration' },
  { id: 'registration.invitation', supportedModes: both, defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'registration-policy' },
  { id: 'registration.public', supportedModes: both, defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'registration-policy' },
  { id: 'risk.advanced', supportedModes: ['hosted'], defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
  { id: 'usage.enforcement', supportedModes: ['hosted'], defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
  { id: 'billing.subscription', supportedModes: ['hosted'], defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
  { id: 'compliance.requests', supportedModes: ['hosted'], defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
  { id: 'support.cases', supportedModes: ['hosted'], defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
  { id: 'operations.webBootstrap', supportedModes: ['self-hosted'], defaultByMode: disabled, requires: [], overrideable: false, availabilitySource: 'lifecycle' },
  { id: 'mail.delivery', supportedModes: both, defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
  { id: 'operations.smtpAdmin', supportedModes: ['self-hosted'], defaultByMode: disabled, requires: ['mail.delivery'], overrideable: true, availabilitySource: 'configuration' },
  { id: 'operations.unifiedBackup', supportedModes: ['self-hosted'], defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
  { id: 'operations.upgradeAssistant', supportedModes: ['self-hosted'], defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
  { id: 'operations.preserveRestore', supportedModes: ['self-hosted'], defaultByMode: disabled, requires: [], overrideable: true, availabilitySource: 'configuration' },
]

const definitionById = new Map(definitions.map((definition) => [definition.id, definition]))

export class CapabilityRegistry {
  constructor(private readonly config: AppConfig, private readonly deployment: DeploymentService) {
    this.validateOverrides()
  }

  resolvePublic(): Record<CapabilityId, boolean> {
    const mode = this.deployment.getState().deploymentMode
    const result = {} as Record<CapabilityId, boolean>
    for (const definition of definitions) {
      const supported = definition.supportedModes.includes(mode)
      const requested = this.requested(definition, mode)
      const releaseStageAllows = this.releaseStageAllows(definition, mode)
      const lifecycleAllows = definition.id !== 'operations.webBootstrap'
        || this.deployment.canBootstrapAdministrator()
      // Backup and preserve restore are security contracts, not preview
      // toggles. Until the unified writer, artifact-driven apply path and
      // required client epoch fence all exist, no override may advertise them.
      const restoreSafetyAllows = definition.id !== 'operations.preserveRestore'
        && definition.id !== 'operations.unifiedBackup'
      // Hosted's log sink never delivers externally. Self-hosted may expose
      // the transport capability only when the reviewed SMTP adapter is
      // explicitly configured; the worker is assembled from the same config.
      const mailDeliverySafetyAllows = definition.id !== 'mail.delivery'
        || (mode === 'self-hosted' && this.config.mailDriver === 'smtp')
        || (mode === 'hosted' && this.config.hostedReleaseStage === 'internal-test' && this.config.hostedMailProvider === 'log')
      // The admin surface is self-hosted-only and requires the same reviewed
      // SMTP adapter as delivery. Its route assembly independently checks the
      // provider, while the explicit capability override controls discovery.
      const smtpAdminSafetyAllows = definition.id !== 'operations.smtpAdmin'
        || (mode === 'self-hosted' && this.config.mailDriver === 'smtp')
      const policyAllows = definition.id === 'registration.public'
        ? this.deployment.getState().registrationPolicy === 'public'
        : definition.id === 'registration.invitation'
          ? this.deployment.getState().registrationPolicy === 'invitation' : true
      result[definition.id] = supported && requested && releaseStageAllows && lifecycleAllows && restoreSafetyAllows && mailDeliverySafetyAllows && smtpAdminSafetyAllows && policyAllows
    }
    for (const definition of definitions) {
      if (!definition.requires.every((dependency) => result[dependency])) result[definition.id] = false
    }
    return result
  }

  /** Local-operator diagnostic view. It intentionally reports only policy
   * decisions, never provider settings, credentials, or secret presence. */
  explain(id: string): CapabilityExplanation {
    const definition = definitionById.get(id as CapabilityId)
    if (definition === undefined) throw new Error(`Unknown capability: ${id}`)
    const mode = this.deployment.getState().deploymentMode
    const available = this.resolvePublic()
    const reasons: string[] = []
    const requestedBy = this.requestSource(definition)
    if (!definition.supportedModes.includes(mode)) reasons.push('unsupported_deployment_mode')
    if (!this.requested(definition, mode)) reasons.push('not_requested')
    if (!this.releaseStageAllows(definition, mode)) reasons.push('release_stage_gated')
    if (definition.id === 'operations.webBootstrap' && !this.deployment.canBootstrapAdministrator()) reasons.push('lifecycle_gated')
    if (definition.id === 'operations.unifiedBackup' || definition.id === 'operations.preserveRestore') reasons.push('restore_safety_gated')
    if (definition.id === 'mail.delivery' && !(mode === 'self-hosted' && this.config.mailDriver === 'smtp')
      && !(mode === 'hosted' && this.config.hostedReleaseStage === 'internal-test' && this.config.hostedMailProvider === 'log')) reasons.push('mail_delivery_adapter_unavailable')
    if (definition.id === 'operations.smtpAdmin' && !(mode === 'self-hosted' && this.config.mailDriver === 'smtp')) reasons.push('smtp_admin_surface_unavailable')
    if (definition.id === 'registration.public' && this.deployment.getState().registrationPolicy !== 'public') reasons.push('registration_policy_gated')
    if (definition.id === 'registration.invitation' && this.deployment.getState().registrationPolicy !== 'invitation') reasons.push('registration_policy_gated')
    const dependencies = definition.requires.map((dependency) => ({ id: dependency, available: available[dependency] }))
    if (dependencies.some((dependency) => !dependency.available)) reasons.push('dependency_unavailable')
    if (available[definition.id] && reasons.length === 0) reasons.push('available')
    return { id: definition.id, available: available[definition.id], deploymentMode: mode, requestedBy, reasons, dependencies }
  }

  private requested(definition: CapabilityDefinition, mode: DeploymentMode): boolean {
    if (!definition.overrideable) return definition.id === 'operations.webBootstrap'
    if (this.config.capabilitiesEnable.includes(definition.id)) return true
    if (this.config.capabilitiesDisable.includes(definition.id)) return false
    if (mode === 'self-hosted' && this.config.mailDriver === 'smtp'
      && (definition.id === 'mail.delivery' || definition.id === 'operations.smtpAdmin')) return true
    return definition.defaultByMode[mode]
  }

  private requestSource(definition: CapabilityDefinition): CapabilityExplanation['requestedBy'] {
    if (!definition.overrideable) return 'lifecycle'
    if (this.config.capabilitiesEnable.includes(definition.id)) return 'enabled_override'
    if (this.config.capabilitiesDisable.includes(definition.id)) return 'disabled_override'
    if (this.config.deploymentMode === 'self-hosted' && this.config.mailDriver === 'smtp'
      && (definition.id === 'mail.delivery' || definition.id === 'operations.smtpAdmin')) return 'enabled_override'
    return 'default'
  }

  private releaseStageAllows(definition: CapabilityDefinition, mode: DeploymentMode): boolean {
    if (mode !== 'hosted') return true
    if (this.config.hostedReleaseStage === 'live') {
      // The current support implementation is an internal-test customer case
      // core only. It has no staff OIDC boundary or permission-enforced
      // console, so a live config must not advertise it merely because an
      // operator supplied an override.
      return definition.id !== 'support.cases'
    }
    // Test configuration has no external delivery, payment, or actionable
    // compliance surface. Its redacted LogMailProvider may be explicitly
    // enabled for internal identity exercises only. Support is deliberately
    // excluded from this list because its first customer case slice is
    // internal-test only.
    return !['billing.subscription', 'compliance.requests'].includes(definition.id)
  }

  private validateOverrides(): void {
    const enabled = new Set(this.config.capabilitiesEnable)
    const disabledIds = new Set(this.config.capabilitiesDisable)
    for (const id of [...enabled, ...disabledIds]) {
      const definition = definitionById.get(id as CapabilityId)
      if (definition === undefined) throw new Error(`Unknown capability override: ${id}`)
      if (!definition.overrideable) throw new Error(`Capability cannot be overridden: ${id}`)
      if (enabled.has(id) && disabledIds.has(id)) throw new Error(`Capability is both enabled and disabled: ${id}`)
      if (!definition.supportedModes.includes(this.config.deploymentMode)) {
        throw new Error(`Capability is not supported for ${this.config.deploymentMode}: ${id}`)
      }
    }
  }
}
