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

export type AdminAttentionSeverityContract = "info" | "warning" | "blocking"

export interface AdminAttentionContract {
  code: string
  severity: AdminAttentionSeverityContract
  count: number
  details: Record<string, string | number | boolean | null>
}

export interface AdminSummaryContract {
  serverVersion: string
  generatedAt: string
  overview: AdminOverviewContract
  system: AdminSystemStatusContract
  operations: {
    activeJobs: number
    failedJobs: number
    pendingMail: number
    failedMail: number
    maintenanceMode: string
    latestBackupStatus: string | null
    latestBackupAt: string | null
    latestRestoreDrillStatus: string | null
    latestRestoreDrillAt: string | null
  }
  attention: AdminAttentionContract[]
}

export type AdminCapabilityStatusContract =
  | "available" | "disabled" | "unavailable" | "degraded"

export interface AdminCapabilityContract {
  id: string
  lifecycle: "stable" | "experimental"
  status: AdminCapabilityStatusContract
  requestedBy: "enabled_override" | "disabled_override" | "default" | "lifecycle"
  reasons: string[]
  dependencies: Array<{ id: string; available: boolean }>
}

export interface AdminCapabilitiesContract {
  deploymentMode: "self-hosted"
  generatedAt: string
  capabilities: AdminCapabilityContract[]
}

export interface AdminJobContract {
  id: string
  actorAccountId: string
  type: string
  status: string
  progress: number
  result: Record<string, unknown> | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface AdminBackupContract {
  id: string
  jobId: string
  filename: string
  size: string | null
  status: string
  createdAt: string
  completedAt: string | null
}

export interface AdminWebSessionContract {
  id: string
  accountId: string
  accountLogin: string
  expiresAt: string
  lastSeenAt: string
  lastIp: string | null
  userAgent: string | null
  createdAt: string
}

export interface AdminStorageReportContract {
  checked: number
  missing: string[]
  orphaned: string[]
  deleted?: number
}

export interface AdminInvitationContract {
  id: string
  tokenHint: string
  expiresAt: string
  revokedAt: string | null
  maxUses: number
  useCount: number
  delivery: { status: string; errorCode: string | null } | null
}

export interface AdminMailStatusContract {
  configured: boolean
  health: string
  queue: Record<string, number>
}

export interface AdminMailItemContract {
  id: string
  template: string
  status: string
  attempts: number
  maxAttempts: number
  errorCode: string | null
  createdAt: string
  nextAttemptAt: string
}

export interface RuntimeConfigurationContract {
  serverName: string
  maxObjectBytes: number
  maxBlobBytes: number
  changeRetentionDays: number
  versionRetentionDays: number
  tombstoneRetentionDays: number
  mailDefaultLocale: "en" | "zh-CN"
  pendingEmailVerificationDays: number
  accountDeletionCoolingOffDays: number
  accountDeletionRetentionDays: number
  mailDriver: "disabled" | "smtp"
  mailFromAddress: string
  mailFromName: string
  mailReplyTo: string
  smtpHost: string
  smtpPort: number
  smtpTlsMode: "starttls-required" | "starttls" | "tls" | "none"
  smtpUsername: string
  smtpPasswordConfigured: boolean
  smtpConnectTimeoutMs: number
  smtpCommandTimeoutMs: number
  smtpTlsRejectUnauthorized: boolean
}

export interface RuntimeConfigurationResponseContract {
  editable: boolean
  revision: string
  runtimeConfiguration: RuntimeConfigurationContract | null
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
  syncStatus: "caught-up" | "behind" | "never-acknowledged"
  pendingEventCount: string
  acknowledgedAt: string | null
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
  storageUsage: {
    activeObjectBytes: string
    activeCrdtBytes: string
    activeBlobBytes: string
    reservedBlobBytes: string
    retainedBytes: string
  } | null
  kinds: Array<{
    kind: string
    activeCount: number
    deletedCount: number
    updatedAt: string
  }>
  activityTimeline: Array<{
    startedAt: string
    updates: number
    deletes: number
    kinds: Array<{
      kind: string
      updates: number
      deletes: number
    }>
  }>
  activityKinds: Array<{
    kind: string
    count: number
  }>
}

export type SyncObjectKindContract =
  | "note" | "folder" | "asset" | "canvas" | "tag" | "mark"
  | "conversation" | "message" | "memory" | "setting" | "yjs-checkpoint" | "yjs-update"

export type WorkspaceTypeContract = "account-data" | "library"
export type WorkspaceRoleContract = "owner" | "viewer" | "editor" | "manager"
export type WorkspaceCapabilityContract =
  | "content.read" | "content.create" | "content.update" | "content.delete"
  | "history.view" | "history.restore"
  | "member.invite" | "member.update" | "member.remove"
  | "workspace.rename" | "workspace.delete"

export interface SyncSessionContract {
  protocol: { requestedVersion: number, selectedVersion: 1, compatible: boolean }
  workspace: {
    id: string
    type: WorkspaceTypeContract
    role: WorkspaceRoleContract
    owner: boolean
    capabilities: WorkspaceCapabilityContract[]
  }
  cursor: {
    supplied: string
    state: "valid" | "ahead" | "expired"
    acknowledged: string
    oldestAvailableSequence: string | null
  }
  latestSequence: string
  bootstrap: {
    required: boolean
    reason: "cursor_ahead" | "cursor_expired" | "device_uninitialized" | "lag_too_large" | null
  }
  limits: {
    maxCommandsPerBatch: number
    maxEventsPerPage: number
    maxBootstrapObjectsPerPage: number
    maxDocumentUpdatesPerPage: number
    maxObjectBytes: number
  }
  keyVersions: Array<{ keyVersion: number, createdAt: string }>
  syncEpoch: string
  websocketUrl: string
}

export interface WebWorkspaceContract {
  id: string
  nameCiphertext: string
  type: "account-data" | "library"
  isDefault: boolean
  isNoteGenDefault: boolean
  latestSequence: string
  latestKeyVersion: number
  encryptionMode: "managed" | "e2ee"
  objectCount: number
  deletedObjectCount: number
  createdAt: string
  updatedAt: string
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
  syncEpoch: string
  serverName: string
  serverVersion: string
  serverTime: string
  publicBaseUrl: string
  protocol: { minimum: 1, maximum: 1 }
  features: {
    durableCrdtUpdates: boolean
    synchronizedConflicts: boolean
    assetObjects: boolean
    [key: string]: boolean
  }
  registrationMode: "closed" | "open"
  capabilitySchema: 2
  instanceCapabilityRevision: string
  registrationPolicyRevision: string
  requiredSyncFeatures: string[]
  registration: {
    policy: "bootstrap" | "disabled" | "invitation" | "public"
    methods: string[]
    emailVerificationRequired: boolean
  }
  instanceCapabilities: Record<string, boolean>
  deploymentMode: "self-hosted"
  web: {
    accountUrl: string
    deviceAuthorizationUrl: string
  }
}

export interface SyncEventContract {
  eventId: string
  sequence: string
  commandId: string
  sourceDeviceId: string
  type: 'object.upserted' | 'object.deleted' | 'document.updated'
    | 'document.checkpointed' | 'conflict.created' | 'conflict.resolved'
  objectId: string | null
  documentId: string | null
  documentSequence: string | null
  keyVersion: number | null
  ciphertext: string | null
  ciphertextHash: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface SyncCommandResultContract {
  commandId: string
  status: 'applied' | 'conflict' | 'rejected'
  duplicate: boolean
  sequence?: string
  revision?: string
  documentSequence?: string
  conflictId?: string
  code?: string
  retryable?: boolean
  details?: Record<string, unknown>
}
