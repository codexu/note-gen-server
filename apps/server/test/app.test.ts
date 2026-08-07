import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'

const config: AppConfig = {
  nodeEnv: 'test', host: '127.0.0.1', port: 3789,
  databaseUrl: 'postgresql://unused', databasePoolSize: 1,
  publicBaseUrl: 'http://localhost:3789',
  serverName: 'Test NoteGen Sync Server',
  trustProxy: false,
  authSecret: 'test-auth-secret-that-is-long-enough',
  setupToken: 'test-setup-token-long-enough',
  registrationMode: 'closed', blobStorageDriver: 'filesystem',
  blobStoragePath: './data/test-blobs', backupPath: './data/test-backups', maxObjectBytes: 1024, maxRequestBytes: 1024 * 1024,
  maxBlobBytes: 2048,
  blobPartBytes: 1024 * 1024,
  s3Endpoint: '', s3Region: 'us-east-1', s3Bucket: '', s3AccessKeyId: '',
  s3SecretAccessKey: '', s3ForcePathStyle: true,
  changeRetentionDays: 90, versionRetentionDays: 90, tombstoneRetentionDays: 90,
  logLevel: 'silent',
  metricsEnabled: false, metricsToken: '', openApiEnabled: false,
  corsOrigins: [],
  webEnabled: false,
  webDistPath: '../web/out',
  webPublicBaseUrl: 'http://localhost:3789',
  deploymentMode: 'self-hosted',
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

const healthyDependencies = {
  version: '0.1.0-test',
  instanceId: '0198f35d-30e1-7000-8000-000000000001',
  database: { check: async () => undefined, close: async () => undefined },
  blobStorage: { check: async () => undefined },
}

describe('service foundation', () => {
  it('reports liveness without touching dependencies', async () => {
    app = await buildApp(config, healthyDependencies)
    const response = await app.inject({ method: 'GET', url: '/health/live' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', version: '0.1.0-test' })
  })

  it('fails readiness when a required dependency is unavailable', async () => {
    app = await buildApp(config, {
      ...healthyDependencies,
      database: {
        check: async () => { throw new Error('database unavailable') },
        close: async () => undefined,
      },
    })
    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ status: 'not_ready' })
  })

  it('publishes truthful protocol capabilities', async () => {
    app = await buildApp(config, healthyDependencies)
    const response = await app.inject({ method: 'GET', url: '/v1/capabilities' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      service: 'note-gen-server',
      serverVersion: '0.1.0-test',
      protocol: { minimum: 1, maximum: 1 },
      features: {
        deltaSync: true, webSocketWakeUp: true, endToEndEncryption: true,
        managedDefaultWorkspace: true,
        blobUpload: true, yjsUpdates: true, collaboration: false,
      },
    })
  })

  it('returns the stable error envelope for unknown routes', async () => {
    app = await buildApp(config, healthyDependencies)
    const response = await app.inject({ method: 'GET', url: '/missing' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'route_not_found', retryable: false })
  })

  it('does not expose metrics when metrics are disabled', async () => {
    app = await buildApp(config, healthyDependencies)
    const response = await app.inject({ method: 'GET', url: '/metrics' })
    expect(response.statusCode).toBe(404)
  })

  it('does not expose OpenAPI when OpenAPI is disabled', async () => {
    app = await buildApp(config, healthyDependencies)
    const response = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(response.statusCode).toBe(404)
  })
})
