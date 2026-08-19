import type { AppConfig } from '../config.js'
import type { DeploymentService } from './service.js'

export const capabilityIds = [
  'identity.email', 'identity.emailVerification', 'identity.passwordReset',
  'registration.invitation', 'registration.public', 'operations.webBootstrap',
  'mail.delivery', 'operations.smtpAdmin', 'operations.unifiedBackup',
  'operations.upgradeAssistant', 'operations.preserveRestore',
] as const

export type CapabilityId = typeof capabilityIds[number]

export interface CapabilityExplanation {
  id: CapabilityId
  available: boolean
  deploymentMode: 'self-hosted'
  requestedBy: 'enabled_override' | 'disabled_override' | 'default' | 'lifecycle'
  reasons: string[]
  dependencies: Array<{ id: CapabilityId, available: boolean }>
}

interface CapabilityDefinition {
  readonly id: CapabilityId
  readonly requires: readonly CapabilityId[]
  readonly overrideable: boolean
}

const definitions: readonly CapabilityDefinition[] = [
  { id: 'identity.email', requires: ['mail.delivery'], overrideable: true },
  { id: 'identity.emailVerification', requires: ['identity.email'], overrideable: true },
  { id: 'identity.passwordReset', requires: ['identity.email'], overrideable: true },
  { id: 'registration.invitation', requires: [], overrideable: true },
  { id: 'registration.public', requires: [], overrideable: true },
  { id: 'operations.webBootstrap', requires: [], overrideable: false },
  { id: 'mail.delivery', requires: [], overrideable: true },
  { id: 'operations.smtpAdmin', requires: ['mail.delivery'], overrideable: true },
  { id: 'operations.unifiedBackup', requires: [], overrideable: true },
  { id: 'operations.upgradeAssistant', requires: [], overrideable: true },
  { id: 'operations.preserveRestore', requires: [], overrideable: true },
]

const definitionById = new Map(definitions.map((definition) => [definition.id, definition]))

export class CapabilityRegistry {
  constructor(private readonly config: AppConfig, private readonly deployment: DeploymentService) {
    this.validateOverrides()
  }

  resolvePublic(): Record<CapabilityId, boolean> {
    const result = {} as Record<CapabilityId, boolean>
    for (const definition of definitions) {
      const requested = this.requested(definition)
      const lifecycleAllows = definition.id !== 'operations.webBootstrap'
        || this.deployment.canBootstrapAdministrator()
      const restoreSafetyAllows = definition.id !== 'operations.preserveRestore'
        && definition.id !== 'operations.unifiedBackup'
      const mailDeliverySafetyAllows = definition.id !== 'mail.delivery'
        || this.config.mailDriver === 'smtp'
      const smtpAdminSafetyAllows = definition.id !== 'operations.smtpAdmin'
        || this.config.mailDriver === 'smtp'
      const policyAllows = definition.id === 'registration.public'
        ? this.deployment.getState().registrationPolicy === 'public'
        : definition.id === 'registration.invitation'
          ? this.deployment.getState().registrationPolicy === 'invitation' : true
      result[definition.id] = requested && lifecycleAllows && restoreSafetyAllows
        && mailDeliverySafetyAllows && smtpAdminSafetyAllows && policyAllows
    }
    for (const definition of definitions) {
      if (!definition.requires.every((dependency) => result[dependency])) result[definition.id] = false
    }
    return result
  }

  explain(id: string): CapabilityExplanation {
    const definition = definitionById.get(id as CapabilityId)
    if (definition === undefined) throw new Error(`Unknown capability: ${id}`)
    const available = this.resolvePublic()
    const reasons: string[] = []
    const requestedBy = this.requestSource(definition)
    if (!this.requested(definition)) reasons.push('not_requested')
    if (definition.id === 'operations.webBootstrap' && !this.deployment.canBootstrapAdministrator()) reasons.push('lifecycle_gated')
    if (definition.id === 'operations.unifiedBackup' || definition.id === 'operations.preserveRestore') reasons.push('restore_safety_gated')
    if (definition.id === 'mail.delivery' && this.config.mailDriver !== 'smtp') reasons.push('mail_delivery_adapter_unavailable')
    if (definition.id === 'operations.smtpAdmin' && this.config.mailDriver !== 'smtp') reasons.push('smtp_admin_surface_unavailable')
    if (definition.id === 'registration.public' && this.deployment.getState().registrationPolicy !== 'public') reasons.push('registration_policy_gated')
    if (definition.id === 'registration.invitation' && this.deployment.getState().registrationPolicy !== 'invitation') reasons.push('registration_policy_gated')
    const dependencies = definition.requires.map((dependency) => ({ id: dependency, available: available[dependency] }))
    if (dependencies.some((dependency) => !dependency.available)) reasons.push('dependency_unavailable')
    if (available[definition.id] && reasons.length === 0) reasons.push('available')
    return { id: definition.id, available: available[definition.id], deploymentMode: 'self-hosted', requestedBy, reasons, dependencies }
  }

  private requested(definition: CapabilityDefinition): boolean {
    if (!definition.overrideable) return definition.id === 'operations.webBootstrap'
    if (this.config.capabilitiesEnable.includes(definition.id)) return true
    if (this.config.capabilitiesDisable.includes(definition.id)) return false
    return this.config.mailDriver === 'smtp'
      && (definition.id === 'mail.delivery' || definition.id === 'operations.smtpAdmin')
  }

  private requestSource(definition: CapabilityDefinition): CapabilityExplanation['requestedBy'] {
    if (!definition.overrideable) return 'lifecycle'
    if (this.config.capabilitiesEnable.includes(definition.id)) return 'enabled_override'
    if (this.config.capabilitiesDisable.includes(definition.id)) return 'disabled_override'
    if (this.config.mailDriver === 'smtp'
      && (definition.id === 'mail.delivery' || definition.id === 'operations.smtpAdmin')) return 'enabled_override'
    return 'default'
  }

  private validateOverrides(): void {
    const enabled = new Set(this.config.capabilitiesEnable)
    const disabledIds = new Set(this.config.capabilitiesDisable)
    for (const id of [...enabled, ...disabledIds]) {
      const definition = definitionById.get(id as CapabilityId)
      if (definition === undefined) throw new Error(`Unknown capability override: ${id}`)
      if (!definition.overrideable) throw new Error(`Capability cannot be overridden: ${id}`)
      if (enabled.has(id) && disabledIds.has(id)) throw new Error(`Capability is both enabled and disabled: ${id}`)
    }
  }
}
