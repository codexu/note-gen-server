import type { DatabaseHealth } from './database/client.js'
import type { BlobStorageHealth } from './storage/blob-storage.js'
import type { AuthService } from './auth/service.js'
import type { TokenService } from './auth/tokens.js'
import type { WorkspaceService } from './workspaces/service.js'
import type { SyncService } from './sync/service.js'
import type { ChangeNotifier } from './sync/types.js'
import type { BlobService } from './blobs/service.js'
import type { WebSessionService } from './auth/web-session-service.js'
import type { DeviceAuthorizationService } from './auth/device-authorization-service.js'
import type { DevicePairingService } from './auth/device-pairing-service.js'
import type { AdminService } from './admin/service.js'
import type { DurableSyncService } from './durable-sync/service.js'

export interface ServiceDependencies {
  readonly version: string
  readonly instanceId: string
  readonly database: DatabaseHealth
  readonly blobStorage: BlobStorageHealth
  readonly auth?: AuthService
  readonly tokens?: TokenService
  readonly workspaces?: WorkspaceService
  readonly sync?: SyncService
  readonly notifier?: ChangeNotifier
  readonly blobs?: BlobService
  readonly webSessions?: WebSessionService
  readonly deviceAuthorizations?: DeviceAuthorizationService
  readonly devicePairings?: DevicePairingService
  readonly admin?: AdminService
  readonly syncProtocol?: DurableSyncService
}
