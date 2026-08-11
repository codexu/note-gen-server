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
import type { DeploymentService } from './deployment/service.js'
import type { CapabilityRegistry } from './deployment/capabilities.js'
import type { BackgroundJobService } from './jobs/service.js'
import type { BootstrapService } from './bootstrap/service.js'
import type { InvitationService } from './invitations/service.js'
import type { IdentityService } from './identity/service.js'
import type { EmailIdentityService } from './identity/email-service.js'
import type { UsageService } from './usage/service.js'
import type { EntitlementService } from './billing/service.js'
import type { BillingProvider } from './billing/provider.js'
import type { MailProvider } from './mail/provider.js'
import type { MailOutboxService } from './mail/outbox-service.js'
import type { MailSecretPayloadService } from './mail/secret-payload-service.js'
import type { MailAdminService } from './mail/admin-service.js'
import type { ComplianceService } from './compliance/service.js'
import type { DeletionService } from './compliance/deletion-service.js'
import type { LegalHoldService } from './compliance/legal-hold-service.js'
import type { RiskService } from './risk/service.js'
import type { MaintenanceCoordinator } from './maintenance/coordinator.js'
import type { SupportService } from './support/service.js'
import type { BackupInventoryService } from './backup/inventory-service.js'
import type { StaffService } from './staff/service.js'
import type { StaffSessionService } from './staff/session-service.js'
import type { WebStepUpService } from './step-up/service.js'
import type { AccountServiceAudit } from './audit/service.js'
import type { InstallationService } from './installation/service.js'

export interface ServiceDependencies {
  readonly version: string
  readonly instanceId: string
  /** Changes on every offline restore; additive until syncEpochFencing is required. */
  readonly syncEpoch: string
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
  readonly deployment?: DeploymentService
  readonly capabilities?: CapabilityRegistry
  readonly jobs?: BackgroundJobService
  readonly backupInventory?: BackupInventoryService
  readonly bootstrap?: BootstrapService
  readonly invitations?: InvitationService
  readonly stepUps?: WebStepUpService
  readonly identities?: IdentityService
  readonly emailIdentities?: EmailIdentityService
  readonly usage?: UsageService
  readonly usageHardEnforcementActive?: boolean
  readonly entitlements?: EntitlementService
  readonly billingProvider?: BillingProvider
  readonly mailProvider?: MailProvider
  readonly mailOutbox?: MailOutboxService
  readonly mailSecrets?: MailSecretPayloadService
  readonly mailAdmin?: MailAdminService
  readonly compliance?: ComplianceService
  readonly deletion?: DeletionService
  readonly legalHolds?: LegalHoldService
  readonly risk?: RiskService
  readonly maintenanceCoordinator?: MaintenanceCoordinator
  readonly support?: SupportService
  readonly staff?: StaffService
  readonly staffSessions?: StaffSessionService
  readonly accountAudit?: AccountServiceAudit
  readonly installation?: InstallationService
  readonly onInstallationComplete?: () => void
}
