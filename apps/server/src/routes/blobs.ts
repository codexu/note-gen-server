import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { BlobService } from '../blobs/service.js'
import { requireAuth } from '../auth/http-auth.js'
import type { TokenService } from '../auth/tokens.js'
import type { AuthService } from '../auth/service.js'
import { ApiError } from '../errors.js'
import { CounterString, HashString, NullableTimestamp, Timestamp, UploadedPartResponse } from './api-schemas.js'

const WorkspaceParams = Type.Object({ workspaceId: Type.String({ format: 'uuid' }) })
const UploadParams = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  uploadId: Type.String({ format: 'uuid' }),
})
const PartParams = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  uploadId: Type.String({ format: 'uuid' }),
  partNumber: Type.Integer({ minimum: 1, maximum: 10_000 }),
})
const BlobParams = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  blobId: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
})
const UploadSessionResponse = Type.Object({
  alreadyExists: Type.Boolean(),
  resumed: Type.Boolean(),
  blobId: HashString,
  uploadId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  partBytes: Type.Integer(),
  uploadedParts: Type.Array(UploadedPartResponse),
  expiresAt: NullableTimestamp,
})
const CompletedBlobResponse = Type.Object({
  blobId: HashString,
  size: CounterString,
  ciphertextHash: HashString,
})

export function createBlobRoutes(
  blobs: BlobService,
  tokens: TokenService,
  auth: AuthService,
  partBytes: number,
): FastifyPluginAsyncTypebox {
  return async function blobRoutes(app) {
    app.post('/v1/workspaces/:workspaceId/blobs/uploads', {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorkspaceParams,
        body: Type.Object({
          blobId: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
          expectedSize: Type.String({ pattern: '^\\d{1,19}$' }),
          ciphertextHash: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
        }),
        response: { 200: UploadSessionResponse, 201: UploadSessionResponse },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      const upload = await blobs.createUpload(claims.accountId, request.params.workspaceId, request.body)
      return reply.status(upload.alreadyExists || upload.resumed ? 200 : 201).send(upload)
    })

    app.put('/v1/workspaces/:workspaceId/blobs/uploads/:uploadId/parts/:partNumber', {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      bodyLimit: partBytes,
      schema: {
        params: PartParams,
        response: {
          200: Type.Object({
            partNumber: Type.Integer(),
            etag: Type.String(),
            receivedSize: CounterString,
          }),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      if (!Buffer.isBuffer(request.body)) {
        throw new ApiError({ code: 'blob_part_invalid', message: 'Expected application/octet-stream', statusCode: 415 })
      }
      return blobs.writePart(
        claims.accountId, request.params.workspaceId, request.params.uploadId,
        request.params.partNumber, request.body,
      )
    })

    app.get('/v1/workspaces/:workspaceId/blobs/uploads/:uploadId', {
      schema: {
        params: UploadParams,
        response: {
          200: Type.Object({
            uploadId: Type.String({ format: 'uuid' }),
            blobId: HashString,
            expectedSize: CounterString,
            receivedSize: CounterString,
            partBytes: Type.Integer(),
            expiresAt: Timestamp,
            completingAt: NullableTimestamp,
            completedAt: NullableTimestamp,
            uploadedParts: Type.Array(UploadedPartResponse),
          }),
        },
      },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return blobs.uploadStatus(claims.accountId, request.params.workspaceId, request.params.uploadId)
    })

    app.post('/v1/workspaces/:workspaceId/blobs/uploads/:uploadId/complete', {
      schema: { params: UploadParams, response: { 200: CompletedBlobResponse } },
    }, async (request) => {
      const claims = await requireAuth(request, tokens, auth)
      return blobs.complete(claims.accountId, request.params.workspaceId, request.params.uploadId)
    })

    app.delete('/v1/workspaces/:workspaceId/blobs/uploads/:uploadId', {
      schema: { params: UploadParams, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await blobs.abort(claims.accountId, request.params.workspaceId, request.params.uploadId)
      return reply.status(204).send(null)
    })

    app.head('/v1/workspaces/:workspaceId/blobs/:blobId', {
      schema: { params: BlobParams, response: { 200: Type.Null() } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      const blob = await blobs.get(claims.accountId, request.params.workspaceId, request.params.blobId)
      return reply.headers({
        'content-length': blob.size.toString(),
        'x-ciphertext-hash': blob.ciphertextHash,
      }).status(200).send(null)
    })

    app.get('/v1/workspaces/:workspaceId/blobs/:blobId', {
      schema: { params: BlobParams, response: {
        200: Type.Any(),
        206: Type.Any(),
      } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      const metadata = await blobs.get(claims.accountId, request.params.workspaceId, request.params.blobId)
      const range = parseRange(request.headers.range, metadata.size)
      const opened = await blobs.open(claims.accountId, request.params.workspaceId, request.params.blobId, range ?? undefined)
      reply.header('accept-ranges', 'bytes').header('x-ciphertext-hash', metadata.ciphertextHash)
      if (range !== null) {
        reply.status(206)
        reply.header('content-range', `bytes ${range.start}-${range.end}/${metadata.size}`)
        reply.header('content-length', String(range.end - range.start + 1))
      } else {
        reply.header('content-length', metadata.size.toString())
      }
      return reply.type('application/octet-stream').send(opened.stream)
    })
  }
}

function parseRange(value: string | undefined, size: bigint): { start: number, end: number } | null {
  if (value === undefined) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (match?.[1] === undefined) {
    throw new ApiError({ code: 'range_invalid', message: 'Byte range is invalid', statusCode: 416 })
  }
  const start = BigInt(match[1])
  const requestedEnd = match[2] === undefined || match[2] === '' ? size - 1n : BigInt(match[2])
  const end = requestedEnd >= size ? size - 1n : requestedEnd
  if (start > end || end > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiError({ code: 'range_invalid', message: 'Byte range is outside the blob', statusCode: 416 })
  }
  return { start: Number(start), end: Number(end) }
}
