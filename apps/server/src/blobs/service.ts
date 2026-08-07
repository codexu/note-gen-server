import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import { blobUploadParts, blobUploads, blobs } from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { BlobStorage } from '../storage/blob-storage.js'
import type { WorkspaceService } from '../workspaces/service.js'
import { BLOB_COMPLETION_LEASE_MS } from './constants.js'

export class BlobService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly workspaces: WorkspaceService,
    private readonly storage: BlobStorage,
    private readonly maxBlobBytes: number,
    private readonly partBytes: number,
  ) {}

  async createUpload(
    accountId: string,
    workspaceId: string,
    input: { blobId: string, expectedSize: string, ciphertextHash: string },
  ) {
    await this.workspaces.assertOwned(accountId, workspaceId)
    const expectedSize = parseSize(input.expectedSize)
    if (expectedSize === 0n) {
      throw new ApiError({ code: 'blob_empty', message: 'Blob must contain at least one byte', statusCode: 400 })
    }
    if (expectedSize > BigInt(this.maxBlobBytes)) {
      throw new ApiError({ code: 'blob_too_large', message: 'Blob exceeds the configured limit', statusCode: 413 })
    }
    const [existing] = await this.database.db.select().from(blobs).where(and(
      eq(blobs.workspaceId, workspaceId), eq(blobs.blobId, input.blobId),
    )).limit(1)
    if (existing?.state === 'ready') {
      assertBlobIdentity(existing, expectedSize, input.ciphertextHash)
      return {
        alreadyExists: true, resumed: false, blobId: input.blobId,
        uploadId: null, partBytes: this.partBytes, uploadedParts: [], expiresAt: null,
      }
    }
    if (existing !== undefined) {
      assertBlobIdentity(existing, expectedSize, input.ciphertextHash)
      const completionLeaseCutoff = new Date(Date.now() - BLOB_COMPLETION_LEASE_MS)
      const [active] = await this.database.db.select().from(blobUploads).where(and(
        eq(blobUploads.workspaceId, workspaceId), eq(blobUploads.blobId, input.blobId),
        isNull(blobUploads.completedAt),
        or(gt(blobUploads.expiresAt, new Date()), gt(blobUploads.completingAt, completionLeaseCutoff)),
      )).orderBy(desc(blobUploads.createdAt)).limit(1)
      if (active !== undefined) {
        return {
          alreadyExists: false,
          resumed: true,
          blobId: input.blobId,
          uploadId: active.id,
          partBytes: this.partBytes,
          uploadedParts: await this.#listParts(active.id),
          expiresAt: active.expiresAt,
        }
      }
      const [stale] = await this.database.db.select().from(blobUploads).where(and(
        eq(blobUploads.workspaceId, workspaceId), eq(blobUploads.blobId, input.blobId),
      )).orderBy(desc(blobUploads.createdAt)).limit(1)
      if (stale !== undefined && stale.completedAt !== null) {
        throw new ApiError({
          code: 'blob_state_invalid',
          message: 'Blob upload metadata is inconsistent; run server maintenance',
          statusCode: 409,
          retryable: true,
        })
      }
      if (stale !== undefined) {
        await this.storage.abortUpload(stale.storageKey, stale.providerUploadId).catch(() => undefined)
        await this.database.db.delete(blobUploads).where(eq(blobUploads.id, stale.id))
      }
    }

    const storageKey = `${workspaceId}/${input.blobId.slice(0, 2)}/${input.blobId}`
    const providerUploadId = await this.storage.beginUpload(storageKey)
    try {
      const [upload] = await this.database.db.transaction(async (tx) => {
        await tx.insert(blobs).values({
          workspaceId, blobId: input.blobId, size: expectedSize,
          ciphertextHash: input.ciphertextHash, storageKey, state: 'uploading',
        }).onConflictDoUpdate({
          target: [blobs.workspaceId, blobs.blobId],
          set: {
            size: expectedSize, ciphertextHash: input.ciphertextHash,
            storageKey, state: 'uploading', updatedAt: new Date(),
          },
        })
        return tx.insert(blobUploads).values({
          workspaceId, blobId: input.blobId, storageKey, providerUploadId,
          expectedSize, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }).returning({ id: blobUploads.id, expiresAt: blobUploads.expiresAt })
      })
      if (upload === undefined) throw new Error('Blob upload insert returned no row')
      return {
        alreadyExists: false,
        resumed: false,
        blobId: input.blobId,
        uploadId: upload.id,
        partBytes: this.partBytes,
        uploadedParts: [],
        expiresAt: upload.expiresAt,
      }
    } catch (error) {
      await this.storage.abortUpload(storageKey, providerUploadId).catch(() => undefined)
      if (databaseErrorCode(error) === '23505') {
        throw new ApiError({
          code: 'blob_upload_raced',
          message: 'Another upload session was created for this blob; retry creation to resume it',
          statusCode: 409,
          retryable: true,
        })
      }
      throw error
    }
  }

  async writePart(
    accountId: string,
    workspaceId: string,
    uploadId: string,
    partNumber: number,
    data: Buffer,
  ) {
    await this.workspaces.assertOwned(accountId, workspaceId)
    if (data.byteLength === 0 || data.byteLength > this.partBytes) {
      throw new ApiError({ code: 'blob_part_invalid', message: 'Blob part size is invalid', statusCode: 400 })
    }
    const upload = await this.#getActiveUpload(workspaceId, uploadId)
    const expectedPartSize = partSize(upload.expectedSize, this.partBytes, partNumber)
    if (expectedPartSize === null || BigInt(data.byteLength) !== expectedPartSize) {
      throw new ApiError({
        code: 'blob_part_size_mismatch',
        message: 'Blob part does not match the expected offset or size',
        statusCode: 400,
        details: {
          partNumber,
          expectedSize: expectedPartSize?.toString() ?? null,
          actualSize: String(data.byteLength),
        },
      })
    }
    const etag = await this.storage.writePart(upload.storageKey, upload.providerUploadId, partNumber, data)
    await this.database.db.insert(blobUploadParts).values({
      uploadId, partNumber, size: BigInt(data.byteLength), etag,
    }).onConflictDoUpdate({
      target: [blobUploadParts.uploadId, blobUploadParts.partNumber],
      set: { size: BigInt(data.byteLength), etag },
    })
    const [sum] = await this.database.db.select({
      received: sql<bigint>`coalesce(sum(${blobUploadParts.size}), 0)`,
    }).from(blobUploadParts).where(eq(blobUploadParts.uploadId, uploadId))
    const received = BigInt(sum?.received ?? 0)
    await this.database.db.update(blobUploads).set({ receivedSize: received })
      .where(eq(blobUploads.id, uploadId))
    return { partNumber, etag, receivedSize: received.toString() }
  }

  async complete(accountId: string, workspaceId: string, uploadId: string) {
    await this.workspaces.assertOwned(accountId, workspaceId)
    const existing = await this.#getUpload(workspaceId, uploadId)
    if (existing.completedAt !== null) {
      const blob = await this.get(accountId, workspaceId, existing.blobId)
      return { blobId: blob.blobId, size: blob.size.toString(), ciphertextHash: blob.ciphertextHash }
    }
    const now = new Date()
    if (existing.expiresAt <= now && existing.completingAt === null) {
      throw new ApiError({ code: 'blob_upload_not_found', message: 'Blob upload is missing or expired', statusCode: 404 })
    }
    const claimedAt = new Date()
    const staleBefore = new Date(claimedAt.getTime() - BLOB_COMPLETION_LEASE_MS)
    const [upload] = await this.database.db.update(blobUploads).set({ completingAt: claimedAt }).where(and(
      eq(blobUploads.id, uploadId),
      eq(blobUploads.workspaceId, workspaceId),
      isNull(blobUploads.completedAt),
      or(
        and(isNull(blobUploads.completingAt), gt(blobUploads.expiresAt, claimedAt)),
        lt(blobUploads.completingAt, staleBefore),
      ),
    )).returning()
    if (upload === undefined) {
      const current = await this.#getUpload(workspaceId, uploadId)
      if (current.completedAt !== null) {
        const blob = await this.get(accountId, workspaceId, current.blobId)
        return { blobId: blob.blobId, size: blob.size.toString(), ciphertextHash: blob.ciphertextHash }
      }
      throw new ApiError({
        code: 'blob_upload_completing',
        message: 'Blob completion is already in progress',
        statusCode: 409,
        retryable: true,
      })
    }

    try {
      const parts = await this.database.db.select().from(blobUploadParts)
        .where(eq(blobUploadParts.uploadId, uploadId)).orderBy(asc(blobUploadParts.partNumber))
      const total = parts.reduce((sum, part) => sum + part.size, 0n)
      const expectedPartCount = Number((upload.expectedSize + BigInt(this.partBytes) - 1n) / BigInt(this.partBytes))
      const partsValid = parts.length === expectedPartCount && parts.every((part, index) => (
        part.partNumber === index + 1 && part.size === partSize(upload.expectedSize, this.partBytes, index + 1)
      ))
      if (total !== upload.expectedSize || !partsValid) {
        throw new ApiError({ code: 'blob_incomplete', message: 'Uploaded parts do not match expected size', statusCode: 409 })
      }
      if (!await this.storage.exists(upload.storageKey)) {
        await this.storage.completeUpload(
          upload.storageKey,
          upload.providerUploadId,
          parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
        )
      }
      const digest = await hashStream(await this.storage.openReadStream(upload.storageKey))
      const [blob] = await this.database.db.select({ hash: blobs.ciphertextHash }).from(blobs).where(and(
        eq(blobs.workspaceId, workspaceId), eq(blobs.blobId, upload.blobId),
      )).limit(1)
      if (blob === undefined || digest !== blob.hash) {
        await this.storage.delete(upload.storageKey)
        await this.database.db.transaction(async (tx) => {
          await tx.delete(blobUploads).where(eq(blobUploads.id, uploadId))
          await tx.delete(blobs).where(and(
            eq(blobs.workspaceId, workspaceId), eq(blobs.blobId, upload.blobId),
          ))
        })
        throw new ApiError({ code: 'blob_hash_mismatch', message: 'Completed blob hash does not match', statusCode: 422 })
      }
      await this.database.db.transaction(async (tx) => {
        await tx.update(blobs).set({ state: 'ready', updatedAt: new Date() }).where(and(
          eq(blobs.workspaceId, workspaceId), eq(blobs.blobId, upload.blobId),
        ))
        await tx.update(blobUploads).set({ completedAt: new Date(), completingAt: null, receivedSize: total })
          .where(eq(blobUploads.id, uploadId))
      })
      return { blobId: upload.blobId, size: total.toString(), ciphertextHash: digest }
    } catch (error) {
      await this.database.db.update(blobUploads).set({ completingAt: null }).where(and(
        eq(blobUploads.id, uploadId), eq(blobUploads.completingAt, claimedAt), isNull(blobUploads.completedAt),
      )).catch(() => undefined)
      throw error
    }
  }

  async get(accountId: string, workspaceId: string, blobId: string) {
    await this.workspaces.assertOwned(accountId, workspaceId)
    const [blob] = await this.database.db.select().from(blobs).where(and(
      eq(blobs.workspaceId, workspaceId), eq(blobs.blobId, blobId), eq(blobs.state, 'ready'),
    )).limit(1)
    if (blob === undefined) throw new ApiError({ code: 'blob_not_found', message: 'Blob not found', statusCode: 404 })
    return blob
  }

  async uploadStatus(accountId: string, workspaceId: string, uploadId: string) {
    await this.workspaces.assertOwned(accountId, workspaceId)
    const upload = await this.#getUpload(workspaceId, uploadId)
    return {
      uploadId: upload.id,
      blobId: upload.blobId,
      expectedSize: upload.expectedSize.toString(),
      receivedSize: upload.receivedSize.toString(),
      partBytes: this.partBytes,
      expiresAt: upload.expiresAt,
      completingAt: upload.completingAt,
      completedAt: upload.completedAt,
      uploadedParts: await this.#listParts(upload.id),
    }
  }

  async open(accountId: string, workspaceId: string, blobId: string, range?: { start: number, end: number }) {
    const blob = await this.get(accountId, workspaceId, blobId)
    return { blob, stream: await this.storage.openReadStream(blob.storageKey, range) }
  }

  async abort(accountId: string, workspaceId: string, uploadId: string): Promise<void> {
    await this.workspaces.assertOwned(accountId, workspaceId)
    const upload = await this.#getActiveUpload(workspaceId, uploadId)
    await this.storage.abortUpload(upload.storageKey, upload.providerUploadId)
    await this.database.db.transaction(async (tx) => {
      await tx.delete(blobUploads).where(eq(blobUploads.id, uploadId))
      const [remaining] = await tx.select({ id: blobUploads.id }).from(blobUploads).where(and(
        eq(blobUploads.workspaceId, workspaceId), eq(blobUploads.blobId, upload.blobId),
        isNull(blobUploads.completedAt),
      )).limit(1)
      if (remaining === undefined) {
        await tx.delete(blobs).where(and(
          eq(blobs.workspaceId, workspaceId), eq(blobs.blobId, upload.blobId), eq(blobs.state, 'uploading'),
        ))
      }
    })
  }

  async #getActiveUpload(workspaceId: string, uploadId: string) {
    const [upload] = await this.database.db.select().from(blobUploads).where(and(
      eq(blobUploads.id, uploadId), eq(blobUploads.workspaceId, workspaceId),
      isNull(blobUploads.completedAt), isNull(blobUploads.completingAt), gt(blobUploads.expiresAt, new Date()),
    )).limit(1)
    if (upload === undefined) {
      throw new ApiError({ code: 'blob_upload_not_found', message: 'Blob upload is missing or expired', statusCode: 404 })
    }
    return upload
  }

  async #getUpload(workspaceId: string, uploadId: string) {
    const [upload] = await this.database.db.select().from(blobUploads).where(and(
      eq(blobUploads.id, uploadId), eq(blobUploads.workspaceId, workspaceId),
    )).limit(1)
    if (upload === undefined) {
      throw new ApiError({ code: 'blob_upload_not_found', message: 'Blob upload was not found', statusCode: 404 })
    }
    return upload
  }

  async #listParts(uploadId: string) {
    const parts = await this.database.db.select({
      partNumber: blobUploadParts.partNumber,
      size: blobUploadParts.size,
      etag: blobUploadParts.etag,
    }).from(blobUploadParts).where(eq(blobUploadParts.uploadId, uploadId))
      .orderBy(asc(blobUploadParts.partNumber))
    return parts.map((part) => ({ ...part, size: part.size.toString() }))
  }
}

function parseSize(value: string): bigint {
  if (!/^\d{1,19}$/.test(value)) {
    throw new ApiError({ code: 'request_invalid', message: 'Size is invalid', statusCode: 400 })
  }
  return BigInt(value)
}

function partSize(expectedSize: bigint, partBytes: number, partNumber: number): bigint | null {
  const start = BigInt(partNumber - 1) * BigInt(partBytes)
  if (start >= expectedSize) return null
  const remaining = expectedSize - start
  return remaining > BigInt(partBytes) ? BigInt(partBytes) : remaining
}

function assertBlobIdentity(
  blob: { size: bigint, ciphertextHash: string },
  expectedSize: bigint,
  ciphertextHash: string,
): void {
  if (blob.size !== expectedSize || blob.ciphertextHash !== ciphertextHash) {
    throw new ApiError({
      code: 'blob_identity_conflict',
      message: 'Blob ID is already associated with different encrypted content',
      statusCode: 409,
    })
  }
}

async function hashStream(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('base64url')
}

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
