export const syncObjectKinds = [
  'note', 'folder', 'asset', 'canvas', 'tag', 'mark', 'conversation', 'message',
  'memory', 'setting', 'yjs-checkpoint', 'yjs-update',
] as const

export type SyncObjectKind = typeof syncObjectKinds[number]

export interface PushOperationInput {
  operationId: string
  objectId: string
  kind: SyncObjectKind
  baseRevision: string | null
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
  blobRefs: string[]
  delete: boolean
}

export interface WorkspaceChangeNotice {
  type: 'workspace.changed'
  workspaceId: string
  latestSequence: string
}

export interface WorkspaceKeysChangedNotice {
  type: 'workspace.keys-changed'
  workspaceId: string
  keyVersion: number
}

export interface WorkspaceStateChangedNotice {
  type: 'workspace.state-changed'
  workspaceId: string
  deleted: boolean
}

export interface AccountWorkspacesChangedNotice {
  type: 'account.workspaces-changed'
  accountId: string
}

export interface WorkspaceMembersChangedNotice {
  type: 'workspace.members-changed'
  workspaceId: string
}

export interface WorkspaceMetadataChangedNotice {
  type: 'workspace.metadata-changed'
  workspaceId: string
}

export type SyncNotice = WorkspaceChangeNotice | WorkspaceKeysChangedNotice
  | WorkspaceStateChangedNotice | AccountWorkspacesChangedNotice | WorkspaceMembersChangedNotice
  | WorkspaceMetadataChangedNotice

export interface ChangeNotifier {
  publish(notice: SyncNotice): Promise<void>
  subscribeWorkspace(workspaceId: string, listener: (notice: SyncNotice) => void): () => void
  subscribeAccount(accountId: string, listener: (notice: SyncNotice) => void): () => void
  close(): Promise<void>
}
