import type { FastifyInstance } from 'fastify'
import packageJson from '../package.json' with { type: 'json' }
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase, type DatabaseContext } from './database/client.js'
import { getOrCreateInstanceId } from './database/instance.js'
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
import { CollaborationService } from './collab/service.js'

async function main(): Promise<void> {
  const config = loadConfig()
  let database: DatabaseContext | undefined
  let notifier: PostgresChangeNotifier | undefined
  let app: FastifyInstance | undefined
  let stopMaintenance: (() => void) | undefined
  let shutdownPromise: Promise<void> | undefined
  let collaboration: CollaborationService | undefined

  const shutdown = (signal: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      app?.log.info({ signal }, 'Shutting down')
      stopMaintenance?.()
      await app?.close().catch((error: unknown) => app?.log.error({ err: error }, 'Failed to close HTTP server'))
      await notifier?.close().catch((error: unknown) => app?.log.error({ err: error }, 'Failed to close notifier'))
      await collaboration?.close().catch((error: unknown) => app?.log.error({ err: error }, 'Failed to close collaboration'))
      await database?.close().catch((error: unknown) => app?.log.error({ err: error }, 'Failed to close database'))
    })()
    return shutdownPromise
  }

  try {
    database = createDatabase(config)
    const instanceId = await getOrCreateInstanceId(database)
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
    const auth = new AuthService(database, tokens, totp)
    const webSessions = new WebSessionService(database)
    const deviceAuthorizations = new DeviceAuthorizationService(database, auth)
    const devicePairings = new DevicePairingService(database, auth)
    const admin = new AdminService(database, blobStorage, config)
    await admin.recoverInterruptedJobs()
    notifier = new PostgresChangeNotifier(database.sql)
    await notifier.initialize()
    const workspaces = new WorkspaceService(database, notifier)
    const sync = new SyncService(database, workspaces, notifier, config.maxObjectBytes)
    collaboration = new CollaborationService(database, workspaces)
    await collaboration.initialize()
    const blobService = new BlobService(
      database, workspaces, blobStorage, config.maxBlobBytes, config.blobPartBytes,
    )
    const maintenance = new MaintenanceService(database, blobStorage, config)

    app = await buildApp(config, {
      version: packageJson.version,
      instanceId,
      database,
      blobStorage,
      tokens,
      auth,
      workspaces,
      sync,
      notifier,
      collaboration,
      blobs: blobService,
      webSessions,
      deviceAuthorizations,
      devicePairings,
      admin,
    })
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
