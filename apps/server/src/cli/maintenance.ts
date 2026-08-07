import { loadConfig } from '../config.js'
import { createDatabase } from '../database/client.js'
import { MaintenanceService } from '../maintenance/service.js'
import { FilesystemBlobStorage } from '../storage/filesystem-blob-storage.js'
import { S3BlobStorage } from '../storage/s3-blob-storage.js'
import type { BlobStorage } from '../storage/blob-storage.js'

const config = loadConfig()
const database = createDatabase({ ...config, databasePoolSize: 1 })
const storage: BlobStorage = config.blobStorageDriver === 's3'
  ? new S3BlobStorage({
      endpoint: config.s3Endpoint, region: config.s3Region, bucket: config.s3Bucket,
      accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey,
      forcePathStyle: config.s3ForcePathStyle,
    })
  : new FilesystemBlobStorage(config.blobStoragePath)

if (storage instanceof FilesystemBlobStorage) await storage.initialize()

try {
  const result = await new MaintenanceService(database, storage, config).runOnce()
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await database.close()
}
