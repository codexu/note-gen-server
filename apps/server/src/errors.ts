import type { FastifyError, FastifyInstance } from 'fastify'

export interface ApiErrorBody {
  code: string
  message: string
  requestId: string
  retryable: boolean
  details?: Record<string, unknown>
}

export class ApiError extends Error {
  readonly code: string
  readonly statusCode: number
  readonly retryable: boolean
  readonly details: Record<string, unknown> | undefined

  constructor(input: {
    code: string
    message: string
    statusCode: number
    retryable?: boolean
    details?: Record<string, unknown>
  }) {
    super(input.message)
    this.name = 'ApiError'
    this.code = input.code
    this.statusCode = input.statusCode
    this.retryable = input.retryable ?? false
    this.details = input.details
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      const retryAfter = error.details?.retryAfterSeconds
      if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
        reply.header('retry-after', String(Math.ceil(retryAfter)))
      }
      const body: ApiErrorBody = {
        code: error.code,
        message: error.message,
        requestId: request.id,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      }
      void reply.status(error.statusCode).send(body)
      return
    }

    if (error.validation !== undefined) {
      const fieldErrors = Object.fromEntries(error.validation.map((item) => [
        item.instancePath.length > 0 ? item.instancePath.replace(/^\//, '').replaceAll('/', '.') : '_root',
        item.message ?? 'Invalid value',
      ]))
      void reply.status(400).send({
        code: 'request_invalid',
        message: 'Request validation failed',
        requestId: request.id,
        retryable: false,
        details: { validation: error.validation, fieldErrors },
      } satisfies ApiErrorBody)
      return
    }

    request.log.error({ err: error }, 'Unhandled request error')
    void reply.status(500).send({
      code: 'internal_error',
      message: 'Internal server error',
      requestId: request.id,
      retryable: true,
    } satisfies ApiErrorBody)
  })

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      code: 'route_not_found',
      message: 'Route not found',
      requestId: request.id,
      retryable: false,
    } satisfies ApiErrorBody)
  })
}
