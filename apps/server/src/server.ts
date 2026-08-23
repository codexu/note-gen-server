import type { FastifyInstance } from 'fastify'
import packageJson from '../package.json' with { type: 'json' }
import { buildApp } from './app.js'
import { applyPersistedDeploymentProfile, loadConfig } from './config.js'
import { createDatabase, type DatabaseContext } from './database/client.js'
import { assertMigrationCompatibility } from './database/migration-compatibility.js'
import { getOrCreateInstanceId } from './database/instance.js'
import { getOrCreateSyncEpoch } from './database/sync-epoch.js'
import { FilesystemBlobStorage } from './storage/filesystem-blob-storage.js'
import { TokenService } from './auth/tokens.js'
import { AuthService } from './auth/service.js'
import { WorkspaceService } from './workspaces/service.js'
import { PostgresChangeNotifier } from './sync/notifier.js'
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
import { UsageService } from './usage/service.js'
import { createMailProvider } from './mail/provider.js'
import { MailOutboxService } from './mail/outbox-service.js'
import { MailSecretPayloadService } from './mail/secret-payload-service.js'
import { MailAdminService } from './mail/admin-service.js'
import { MailOutboxWorker } from './mail/outbox-worker.js'
import { RestoreFenceService } from './restore-fence/service.js'
import { RiskService } from './risk/service.js'
import { MaintenanceCoordinator } from './maintenance/coordinator.js'
import { BackupInventoryService } from './backup/inventory-service.js'
import { AccountServiceAudit } from './audit/service.js'
import { InstallationService } from './installation/service.js'
import { WorkspaceCollaborationService } from './workspaces/collaboration-service.js'

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
    const installationProbe = new InstallationService(database, config, true)
    let persistedInstallation = await installationProbe.persistedSettings()
    if (persistedInstallation === undefined) {
      let finishInstallation!: () => void
      const installationCompleted = new Promise<void>((resolve) => { finishInstallation = resolve })
      const instanceId = await getOrCreateInstanceId(database)
      const syncEpoch = await getOrCreateSyncEpoch(database)
      app = await buildApp(config, {
        version: packageJson.version,
        instanceId,
        syncEpoch,
        database,
        blobStorage: { async check() {} },
        installation: installationProbe,
        onInstallationComplete: finishInstallation,
      })
      const handleSigint = () => void shutdown('SIGINT')
      const handleSigterm = () => void shutdown('SIGTERM')
      process.once('SIGINT', handleSigint)
      process.once('SIGTERM', handleSigterm)
      await app.listen({ host: config.host, port: config.port })
      await installationCompleted
      process.removeListener('SIGINT', handleSigint)
      process.removeListener('SIGTERM', handleSigterm)
      await shutdown('installation-complete')
      await main()
      return
    }
    if (persistedInstallation.deploymentMode !== 'self-hosted') {
      await installationProbe.migrateLegacyOperationsInstallation()
      persistedInstallation = await installationProbe.persistedSettings()
      if (persistedInstallation?.deploymentMode !== 'self-hosted') {
        throw new Error('Legacy operations mode migration did not complete')
      }
    }
    applyPersistedDeploymentProfile(config, 'self-hosted')
    const installation = new InstallationService(database, config, false)
    const deployment = new DeploymentService(database, config)
    await deployment.initialize()
    // Keep deployment safety failures ahead of service assembly and socket binding so a
    // misconfigured instance cannot become reachable through a proxy.
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
    const accountAudit = new AccountServiceAudit(database)
    const risk = new RiskService(database, config.authSecret, config, undefined, accountAudit)
    const bootstrap = new BootstrapService(database, config, deployment)
    await bootstrap.initialize()
    const identities = new IdentityService(database)
    await identities.backfillLegacyIdentities()
    const mailOutbox = new MailOutboxService(database)
    const mailSecrets = new MailSecretPayloadService(database, config.authSecret)
    const mailProvider = createMailProvider(config)
    const mailAdmin = mailProvider !== undefined
      ? new MailAdminService(database, config, mailOutbox, mailSecrets, mailProvider) : undefined
    const invitations = new InvitationService(database, config, deployment, {
      outbox: mailOutbox,
      secrets: mailSecrets,
      deliveryAvailable: () => capabilities.resolvePublic()['mail.delivery'],
    })
    const usage = new UsageService(database)
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
    const auth = new AuthService(database, tokens, totp, risk)
    const webSessions = new WebSessionService(database, risk)
    const stepUps = new WebStepUpService(database, config.authSecret)
    const deviceAuthorizations = new DeviceAuthorizationService(database, auth)
    const devicePairings = new DevicePairingService(database, auth)
    const admin = new AdminService(database, blobStorage, usage, undefined, config, deployment)
    await admin.recoverInterruptedJobs()
    notifier = new PostgresChangeNotifier(database.sql)
    await notifier.initialize()
    const workspaces = new WorkspaceService(database, notifier)
    const workspaceCollaboration = new WorkspaceCollaborationService(database, workspaces, notifier)
    const syncProtocol = new DurableSyncService(database, workspaces, notifier, () => config.maxObjectBytes,
      syncEpoch)
    const blobService = new BlobService(
      database, workspaces, blobStorage, () => config.maxBlobBytes, config.blobPartBytes,
      undefined, undefined, syncEpoch,
    )
    const maintenance = new MaintenanceService(
      database, blobStorage, config, maintenanceCoordinator,
      undefined,
      undefined,
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
      workspaceCollaboration,
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
      usage,
      ...(mailProvider === undefined ? {} : { mailProvider }),
      mailOutbox,
      mailSecrets,
      ...(mailAdmin === undefined ? {} : { mailAdmin }),
      risk,
      maintenanceCoordinator,
      accountAudit,
      installation,
    })
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
