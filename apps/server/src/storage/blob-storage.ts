import type { Readable } from 'node:stream'

export interface CompletedPart {
  partNumber: number
  etag: string
}

export interface BlobStorageHealth {
  check(): Promise<void>
}

export interface BlobStorage extends BlobStorageHealth {
  beginUpload(storageKey: string): Promise<string>
  writePart(storageKey: string, providerUploadId: string, partNumber: number, data: Buffer): Promise<string>
  completeUpload(storageKey: string, providerUploadId: string, parts: CompletedPart[]): Promise<void>
  abortUpload(storageKey: string, providerUploadId: string): Promise<void>
  openReadStream(storageKey: string, range?: { start: number, end: number }): Promise<Readable>
  exists(storageKey: string): Promise<boolean>
  listKeys(): AsyncIterable<string>
  delete(storageKey: string): Promise<void>
}
