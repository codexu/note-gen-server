import { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client,
  ListObjectsV2Command, UploadPartCommand,
} from '@aws-sdk/client-s3'
import type { BlobStorage, CompletedPart } from './blob-storage.js'

export interface S3BlobStorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

export class S3BlobStorage implements BlobStorage {
  readonly #client: S3Client
  readonly #bucket: string

  constructor(config: S3BlobStorageConfig) {
    this.#bucket = config.bucket
    this.#client = new S3Client({
      region: config.region,
      ...(config.endpoint.length === 0 ? {} : { endpoint: config.endpoint }),
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    })
  }

  async check(): Promise<void> {
    await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }))
  }

  async beginUpload(storageKey: string): Promise<string> {
    const result = await this.#client.send(new CreateMultipartUploadCommand({ Bucket: this.#bucket, Key: storageKey }))
    if (result.UploadId === undefined) throw new Error('S3 did not return a multipart upload ID')
    return result.UploadId
  }

  async writePart(storageKey: string, providerUploadId: string, partNumber: number, data: Buffer): Promise<string> {
    const result = await this.#client.send(new UploadPartCommand({
      Bucket: this.#bucket, Key: storageKey, UploadId: providerUploadId, PartNumber: partNumber, Body: data,
    }))
    if (result.ETag === undefined) throw new Error('S3 did not return a part ETag')
    return result.ETag
  }

  async completeUpload(storageKey: string, providerUploadId: string, parts: CompletedPart[]): Promise<void> {
    await this.#client.send(new CompleteMultipartUploadCommand({
      Bucket: this.#bucket,
      Key: storageKey,
      UploadId: providerUploadId,
      MultipartUpload: {
        Parts: parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
      },
    }))
  }

  async abortUpload(storageKey: string, providerUploadId: string): Promise<void> {
    await this.#client.send(new AbortMultipartUploadCommand({
      Bucket: this.#bucket, Key: storageKey, UploadId: providerUploadId,
    }))
  }

  async openReadStream(storageKey: string, range?: { start: number, end: number }): Promise<Readable> {
    const result = await this.#client.send(new GetObjectCommand({
      Bucket: this.#bucket,
      Key: storageKey,
      ...(range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` }),
    }))
    if (!(result.Body instanceof Readable)) throw new Error('S3 response body is not a Node.js stream')
    return result.Body
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: storageKey }))
      return true
    } catch (error) {
      if (typeof error === 'object' && error !== null && '$metadata' in error
        && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false
      throw error
    }
  }

  async *listKeys(): AsyncIterable<string> {
    let continuationToken: string | undefined
    do {
      const result = await this.#client.send(new ListObjectsV2Command({
        Bucket: this.#bucket,
        ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
      }))
      for (const item of result.Contents ?? []) if (item.Key !== undefined) yield item.Key
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
    } while (continuationToken !== undefined)
  }

  async delete(storageKey: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: storageKey }))
  }
}
