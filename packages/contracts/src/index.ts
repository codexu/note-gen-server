export interface AccountContract {
  id: string
  login: string
  isAdmin: boolean
  totpEnabled: boolean
}

export interface AdminOverviewContract {
  accountCount: number
  activeAccountCount: number
  workspaceCount: number
  objectCount: number
  deletedObjectCount: number
  activeDeviceCount: number
  auditCount: number
}

export interface AdminAccountContract {
  id: string
  login: string
  isAdmin: boolean
  suspendedAt: string | null
  deletionRequestedAt: string | null
  createdAt: string
  workspaceCount: number
  objectCount: number
  deviceCount: number
}

export interface AdminAccountPageContract {
  total: number
  nextCursor: string | null
  accounts: AdminAccountContract[]
}

export interface AdminAuditEntryContract {
  id: string
  actorAccountId: string
  actorLogin: string
  action: string
  targetType: string
  targetId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AdminAuditPageContract {
  total: number
  nextCursor: string | null
  entries: AdminAuditEntryContract[]
}

export interface AdminWorkspaceContract {
  id: string
  accountId: string
  accountLogin: string
  isDefault: boolean
  deletedAt: string | null
  createdAt: string
  updatedAt: string
  objectCount: number
  deletedObjectCount: number
  objectBytes: string
  encryptionMode: "managed" | "e2ee"
}

export interface AdminWorkspacePageContract {
  total: number
  nextCursor: string | null
  workspaces: AdminWorkspaceContract[]
}

export interface AdminDeviceContract {
  id: string
  accountId: string
  accountLogin: string
  name: string
  platform: string
  revokedAt: string | null
  lastSeenAt: string
  createdAt: string
}

export interface AdminDevicePageContract {
  total: number
  nextCursor: string | null
  devices: AdminDeviceContract[]
}

export interface AdminSystemStatusContract {
  status: "ok"
  databaseLatencyMs: number
  uptimeSeconds: number
  memoryRssBytes: string
  heapUsedBytes: string
  databaseBytes: string
  blobCount: number
  blobBytes: string
  objectBytes: string
  versionCount: number
  changeCount: number
  checkedAt: string
}

export interface DeviceContract {
  id: string
  name: string
  platform: string
  encryptionPublicKey: string | null
  lastSeenAt: string
  createdAt: string
  revokedAt: string | null
  current: boolean
}

export interface SyncOverviewContract {
  workspaceCount: number
  objectCount: number
  deletedObjectCount: number
  objectBytes: string
  blobCount: number
  blobBytes: string
  latestSequence: string
  lastActivityAt: string | null
  encryptionMode: "managed" | "e2ee" | "mixed" | null
  kinds: Array<{
    kind: string
    activeCount: number
    deletedCount: number
    updatedAt: string
  }>
  recentActivity: Array<{
    sequence: string
    kind: string
    changeType: "upsert" | "delete"
    createdAt: string
    device: {
      id: string
      name: string
      platform: string
    }
  }>
}

export type SyncObjectKindContract =
  | "note" | "folder" | "asset" | "canvas" | "record" | "tag" | "mark"
  | "conversation" | "memory" | "setting" | "yjs-checkpoint" | "yjs-update"

export interface WebWorkspaceContract {
  id: string
  nameCiphertext: string
  isDefault: boolean
  latestSequence: string
  latestKeyVersion: number
  encryptionMode: "managed" | "e2ee"
  objectCount: number
  deletedObjectCount: number
  createdAt: string
  updatedAt: string
}

export interface WebWorkspaceKeyContract {
  keyVersion: number
  createdAt: string
  envelopes: Array<{
    id: string
    keyVersion: number
    type: "passphrase" | "recovery" | "device" | "managed"
    recipientId: string | null
    wrappedKey: string
    kdfSalt: string | null
    kdfParams: Record<string, number> | null
    createdAt: string
  }>
}

export interface WebSyncObjectContract {
  objectId: string
  kind: SyncObjectKindContract
  currentRevision: string
  ciphertext: string
  ciphertextHash: string
  ciphertextBytes: string
  keyVersion: number
  blobRefs: string[]
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WebSyncObjectPageContract {
  total: number
  objects: WebSyncObjectContract[]
}

export interface DeviceAuthorizationRequest {
  deviceId: string
  deviceName: string
  platform: string
  encryptionPublicKey?: string
}

export interface DeviceAuthorizationCreated {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface DeviceAuthorizationContract {
  userCode: string
  deviceId: string
  deviceName: string
  platform: string
  status: "pending" | "approved" | "denied"
  expiresAt: string
}

export interface DeviceAuthorizationCancelRequest {
  deviceCode: string
}

export interface ClientSessionContract {
  accountId: string
  deviceId: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
}

export interface ApiErrorContract {
  code: string
  message: string
  requestId: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface ServerCapabilitiesContract {
  service: "note-gen-server"
  instanceId: string
  serverName: string
  serverVersion: string
  publicBaseUrl: string
  registrationMode: "closed" | "open"
  deploymentMode: "self-hosted" | "hosted"
  web: {
    accountUrl: string
    deviceAuthorizationUrl: string
  }
}
