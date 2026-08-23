export const workspaceCapabilities = [
  'content.read',
  'content.create',
  'content.update',
  'content.delete',
  'history.view',
  'history.restore',
  'member.invite',
  'member.update',
  'member.remove',
  'workspace.rename',
  'workspace.delete',
] as const

export type WorkspaceCapability = typeof workspaceCapabilities[number]
export type WorkspaceMemberRole = 'viewer' | 'editor' | 'manager'

export const workspaceRoleTemplates: Readonly<Record<WorkspaceMemberRole, readonly WorkspaceCapability[]>> = {
  viewer: ['content.read', 'history.view'],
  editor: [
    'content.read', 'content.create', 'content.update', 'content.delete',
    'history.view', 'history.restore',
  ],
  manager: [
    'content.read', 'content.create', 'content.update', 'content.delete',
    'history.view', 'history.restore', 'member.invite', 'member.update', 'member.remove',
    'workspace.rename',
  ],
}

const capabilitySet = new Set<string>(workspaceCapabilities)

export function normalizeWorkspaceCapabilities(values: readonly string[]): WorkspaceCapability[] {
  const unique = [...new Set(values)]
  if (unique.some(value => !capabilitySet.has(value))) {
    throw new Error('Unknown workspace capability')
  }
  return workspaceCapabilities.filter(capability => unique.includes(capability))
}

export function capabilitiesForRole(role: WorkspaceMemberRole): WorkspaceCapability[] {
  return [...workspaceRoleTemplates[role]]
}
