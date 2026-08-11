import type { FastifyInstance } from 'fastify'
import packageJson from '../package.json' with { type: 'json' }
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase, type DatabaseContext } from './database/client.js'
import { assertMigrationCompatibility } from './database/migration-compatibility.js'
import { getOrCreateInstanceId } from './database/instance.js'
import { getOrCreateSyncEpoch } from './database/sync-epoch.js'
import { FilesystemBlobStorage } from './storage/filesystem-blob-storage.js'
import { TokenService } from './auth/tokens.js'
import { AuthService } from './auth/service.js'
import { WorkspaceService } from './workspaces/service.js'
import { PostgresChangeNotifier } from './sync/notifier.js'
import { SyncService } from './sync/service.js'
import type { BlobStorage } from './storage/blob-storage.js'
import { S3BlobStorage } from './storage/s3-blob-storage.js'
import { BlobService } from './blobs/service.js'
import { MaintenanceService } from './maintenance/service.js'
import { WebSessionService } from './auth/web-session-service.js'
import { DeviceAuthorizationService } from './auth/device-authorization-service.js'
import { DevicePairingService } from './auth/device-pairing-service.js'
import { AdminService } from './admin/service.js'
import { TotpService } from './auth/totp-service.js'
import { DurableSyncService } from './durable-sync/service.js'
import { DeploymentService } from './deployment/service.js'
import { CapabilityRegistry } from './deployment/capabilities.js'
import { BackgroundJobService } from './jobs/service.js'
import { BootstrapService } from './bootstrap/service.js'
import { InvitationService } from './invitations/service.js'
import { WebStepUpService } from './step-up/service.js'
import { IdentityService } from './identity/service.js'
import { EmailIdentityService } from './identity/email-service.js'
import { UsageService } from './usage/service.js'
import { EntitlementService } from './billing/service.js'
import { createBillingProvider } from './billing/provider.js'
import { createMailProvider } from './mail/provider.js'
import { MailOutboxService } from './mail/outbox-service.js'
import { MailSecretPayloadService } from './mail/secret-payload-service.js'
import { MailAdminService } from './mail/admin-service.js'
import { MailOutboxWorker } from './mail/outbox-worker.js'
import { ComplianceService } from './compliance/service.js'
import { DeletionService } from './compliance/deletion-service.js'
import { LegalHoldService } from './compliance/legal-hold-service.js'
import { RestoreFenceService } from './restore-fence/service.js'
import { RiskService } from './risk/service.js'
import { MaintenanceCoordinator } from './maintenance/coordinator.js'
import { SupportService } from './support/service.js'
import { BackupInventoryService } from './backup/inventory-service.js'
import { StaffService } from './staff/service.js'
import { StaffSessionService } from './staff/session-service.js'
import { AccountServiceAudit } from './audit/service.js'
import { FilesystemDeletionLedgerStore } from './compliance/deletion-ledger-store.js'
import { DeletionLedgerReplayService } from './compliance/deletion-ledger-replay-service.js'

async function main(): Promise<void> {
  const config = loadConfig()
  let database: DatabaseContext | undefined
  let notifier: PostgresChangeNotifier | undefined
  let app: FastifyInstance | undefined
  let stopMaintenance: (() => void) | undefined
  let stopMailOutbox: (() => void) | undefined
  let shutdownPromise: Promise<void> | undefined

  const shutdown = (signal: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      app?.log.info({ signal }, 'Shutting down')
      stopMaintenance?.()
      stopMailOutbox?.()
      await app?.close().catch((error: unknown) => app?.log.error({ err: error }, 'Failed to close HTTP server'))
      await notifier?.close().catch((error: unknown) => app?.log.error({ err: error }, 'Failed to close notifier'))
      await database?.close().catch((error: unknown) => app?.log.error({ err: error }, 'Failed to close database'))
    })()
    return shutdownPromise
  }

  try {
    database = createDatabase(config)
    await assertMigrationCompatibility(database)
    const deployment = new DeploymentService(database, config)
    await deployment.initialize()
    // A readiness-only failure still leaves a listening process available to
    // a misconfigured proxy or direct client. Deployment mode determines the
    // business isolation boundary, so a persisted/configured mode mismatch
    // (or the legacy hosted public-registration hazard) must prevent service
    // assembly and socket binding altogether.
    const deploymentSafetyFailure = deployment.getSafetyFailure()
    if (deploymentSafetyFailure !== undefined) {
      throw new Error(`Deployment safety gate is closed: ${deploymentSafetyFailure}`)
    }
    const capabilities = new CapabilityRegistry(config, deployment)
    const jobs = new BackgroundJobService(database)
    const backupInventory = new BackupInventoryService(database)
    const restoreFence = new RestoreFenceService(database)
    await restoreFence.reconcile()
    const maintenanceCoordinator = new MaintenanceCoordinator(database)
    await maintenanceCoordinator.getSnapshot()
    // Restore credential-review restrictions are a self-hosted recovery
    // boundary too; the durable restriction evaluator has no hosted-provider
    // dependency and must therefore exist in both deployment modes.
    const accountAudit = new AccountServiceAudit(database)
    const staff = config.deploymentMode === 'hosted' ? new StaffService(database) : undefined
    const risk = new RiskService(database, config.authSecret, config, staff, accountAudit)
    const bootstrap = config.deploymentMode === 'self-hosted'
      ? new BootstrapService(database, config, deployment)
      : undefined
    await bootstrap?.initialize()
    const identities = new IdentityService(database)
    await identities.backfillLegacyIdentities()
    const mailOutbox = new MailOutboxService(database)
    const mailSecrets = new MailSecretPayloadService(database, config.authSecret)
    const mailProvider = createMailProvider(config)
    const mailAdmin = config.deploymentMode === 'self-hosted' && mailProvider !== undefined
      ? new MailAdminService(database, config, mailOutbox, mailSecrets, mailProvider) : undefined
    const invitations = new InvitationService(database, config, deployment, {
      outbox: mailOutbox,
      secrets: mailSecrets,
      deliveryAvailable: () => capabilities.resolvePublic()['mail.delivery'],
    })
    const emailIdentities = config.deploymentMode === 'hosted'
      ? new EmailIdentityService(database, config, mailOutbox, mailSecrets, {
          emailVerification: capabilities.resolvePublic()['identity.emailVerification'],
          passwordReset: capabilities.resolvePublic()['identity.passwordReset'],
        }, risk) : undefined
    const usage = new UsageService(database)
    const entitlements = config.deploymentMode === 'hosted'
      ? new EntitlementService(database, config, staff, accountAudit) : undefined
    const usageHardEnforcementActive = config.usageEnforcement === 'hard'
      && capabilities.resolvePublic()['usage.enforcement'] && entitlements !== undefined
    const hardUsageLimitResolver = usageHardEnforcementActive && entitlements !== undefined
      ? async (accountId: string) => entitlementLimit(await entitlements.getEffective(accountId), 'storage_bytes')
      : undefined
    const hardDeviceLimitResolver = usageHardEnforcementActive && entitlements !== undefined
      ? async (accountId: string) => entitlementLimit(await entitlements.getEffective(accountId), 'devices')
      : undefined
    const hardWorkspaceLimitResolver = usageHardEnforcementActive && entitlements !== undefined
      ? async (accountId: string) => entitlementLimit(await entitlements.getEffective(accountId), 'workspaces')
      : undefined
    const billingProvider = createBillingProvider(config)
    const compliance = config.deploymentMode === 'hosted' ? new ComplianceService(database, config) : undefined
    const legalHolds = config.deploymentMode === 'hosted' && staff !== undefined ? new LegalHoldService(database, config, staff, accountAudit) : undefined
    const deletion = config.deploymentMode === 'hosted' ? new DeletionService(database, config, legalHolds, usage, risk) : undefined
    const support = config.deploymentMode === 'hosted' ? new SupportService(database, config, staff, accountAudit) : undefined
    const staffSessions = staff === undefined ? undefined : new StaffSessionService(database, staff, accountAudit)
    const instanceId = await getOrCreateInstanceId(database)
    const syncEpoch = await getOrCreateSyncEpoch(database)
    const blobStorage: BlobStorage = config.blobStorageDriver === 's3'
      ? new S3BlobStorage({
          endpoint: config.s3Endpoint, region: config.s3Region, bucket: config.s3Bucket,
          accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey,
          forcePathStyle: config.s3ForcePathStyle,
        })
      : new FilesystemBlobStorage(config.blobStoragePath)
    if (blobStorage instanceof FilesystemBlobStorage) await blobStorage.initialize()

    const tokens = new TokenService(config.authSecret, config.publicBaseUrl)
    const totp = new TotpService(config.authSecret)
    const auth = new AuthService(database, tokens, totp, risk,
      config.deploymentMode === 'hosted' ? usage : undefined, hardDeviceLimitResolver)
    const webSessions = new WebSessionService(database, risk)
    const stepUps = new WebStepUpService(database, config.authSecret)
    const deviceAuthorizations = new DeviceAuthorizationService(database, auth)
    const devicePairings = new DevicePairingService(database, auth)
    // Instance administration is a self-hosted authority. Hosted operations
    // use the separate staff realm; assembling this service there would leave
    // the customer-admin route surface present even when no customer can
    // legitimately receive isAdmin.
    const admin = config.deploymentMode === 'self-hosted'
      ? new AdminService(database, blobStorage, usage, hardWorkspaceLimitResolver, config, deployment)
      : undefined
    await admin?.recoverInterruptedJobs()
    notifier = new PostgresChangeNotifier(database.sql)
    await notifier.initialize()
    const workspaces = new WorkspaceService(database, notifier,
      config.deploymentMode === 'hosted' ? usage : undefined, hardWorkspaceLimitResolver)
    const sync = new SyncService(database, workspaces, notifier, () => config.maxObjectBytes,
      config.deploymentMode === 'hosted' ? usage : undefined, hardUsageLimitResolver)
    const syncProtocol = new DurableSyncService(database, workspaces, notifier, () => config.maxObjectBytes,
      config.deploymentMode === 'hosted' ? usage : undefined, hardUsageLimitResolver, syncEpoch)
    const blobService = new BlobService(
      database, workspaces, blobStorage, () => config.maxBlobBytes, config.blobPartBytes,
      config.deploymentMode === 'hosted' ? usage : undefined,
      hardUsageLimitResolver, syncEpoch,
    )
    const deletionLedger = config.deploymentMode === 'hosted' ? new FilesystemDeletionLedgerStore(config.deletionLedgerPath) : undefined
    await deletionLedger?.initialize()
    await (deletionLedger === undefined ? undefined : new DeletionLedgerReplayService(database, config, deletionLedger).reconcile())
    const maintenance = new MaintenanceService(
      database, blobStorage, config, maintenanceCoordinator,
      config.deploymentMode === 'hosted' ? usage : undefined,
      deletionLedger,
    )

    app = await buildApp(config, {
      version: packageJson.version,
      instanceId,
      syncEpoch,
      database,
      blobStorage,
      tokens,
      auth,
      workspaces,
      sync,
      syncProtocol,
      notifier,
      blobs: blobService,
      webSessions,
      stepUps,
      deviceAuthorizations,
      devicePairings,
      admin,
      deployment,
      capabilities,
      jobs,
      backupInventory,
      bootstrap,
      invitations,
      identities,
      emailIdentities,
      usage,
      usageHardEnforcementActive,
      entitlements,
      billingProvider,
      mailProvider,
      mailOutbox,
      mailSecrets,
      mailAdmin,
      compliance,
      deletion,
      legalHolds,
      risk,
      support,
      staff,
      staffSessions,
      maintenanceCoordinator,
      accountAudit,
    })
    // Hosted internal-test drains to the redacted LogMailProvider; a
    // self-hosted instance drains only when its explicitly configured SMTP
    // provider assembled successfully. In both cases the durable worker, not
    // an HTTP request, owns network delivery and retry semantics.
    if (mailProvider !== undefined) {
      stopMailOutbox = new MailOutboxWorker(database, mailOutbox, mailProvider, mailSecrets, {
        error: (bindings, message) => app?.log.error(bindings, message),
      }, maintenanceCoordinator).start()
    }
    stopMaintenance = maintenance.start(60 * 60 * 1_000, (error) => {
      app?.log.error({ err: error }, 'Scheduled maintenance failed')
    })

    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
    await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    if (app !== undefined) app.log.fatal({ err: error }, 'Failed to start server')
    else console.error('Failed to start server', error)
    await shutdown('startup-error')
    process.exitCode = 1
  }
}

await main()

function entitlementLimit(entitlements: { limits: Record<string, string | null> }, metric: string): bigint | null {
  const value = entitlements.limits[metric]
  return value === undefined || value === null ? null : BigInt(value)
}
