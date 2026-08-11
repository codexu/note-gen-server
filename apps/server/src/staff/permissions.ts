/** Typed authorization registry for the future independent hosted staff realm.
 * Customer `accounts.isAdmin` is deliberately absent from this module. */
export const staffPermissions = [
  'risk.read', 'risk.manage', 'risk.admin',
  'billing.read', 'billing.grant', 'billing.admin',
  'compliance.request.process', 'legal_hold.read', 'legal_hold.manage', 'legal_hold.approve',
  'support.read', 'support.write', 'support.diagnostics', 'platform.provision',
] as const

export type StaffPermission = typeof staffPermissions[number]

export const staffRoleTemplates = {
  'security-analyst': ['risk.read'] as const,
  'security-admin': ['risk.read', 'risk.manage', 'risk.admin'] as const,
  'billing-support': ['billing.read'] as const,
  'billing-admin': ['billing.read', 'billing.grant', 'billing.admin'] as const,
  'compliance-operator': ['compliance.request.process'] as const,
  'legal-hold-admin': ['legal_hold.read', 'legal_hold.manage', 'legal_hold.approve'] as const,
  'support-read': ['support.read'] as const,
  'support-write': ['support.read', 'support.write'] as const,
  'support-diagnostics': ['support.read', 'support.write', 'support.diagnostics'] as const,
  'platform-operator': ['platform.provision'] as const,
} as const satisfies Record<string, readonly StaffPermission[]>

export type StaffRoleKey = keyof typeof staffRoleTemplates

export function permissionsForStaffRoles(roleKeys: readonly string[]): Set<StaffPermission> {
  const permissions = new Set<StaffPermission>()
  for (const roleKey of roleKeys) {
    const template = staffRoleTemplates[roleKey as StaffRoleKey]
    if (template !== undefined) for (const permission of template) permissions.add(permission)
  }
  return permissions
}
