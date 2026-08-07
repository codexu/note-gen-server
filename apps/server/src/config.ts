import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'

const EnvironmentSchema = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('test'), Type.Literal('production')]),
  HOST: Type.String({ minLength: 1 }),
  PORT: Type.Integer({ minimum: 1, maximum: 65_535 }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  DATABASE_POOL_SIZE: Type.Integer({ minimum: 1, maximum: 100 }),
  PUBLIC_BASE_URL: Type.String({ minLength: 1 }),
  SERVER_NAME: Type.String({ minLength: 1, maxLength: 100 }),
  TRUST_PROXY: Type.Boolean(),
  AUTH_SECRET: Type.String({ minLength: 32 }),
  SETUP_TOKEN: Type.String({ minLength: 16 }),
  REGISTRATION_MODE: Type.Union([Type.Literal('closed'), Type.Literal('open')]),
  BLOB_STORAGE_DRIVER: Type.Union([Type.Literal('filesystem'), Type.Literal('s3')]),
  BLOB_STORAGE_PATH: Type.String({ minLength: 1 }),
  BACKUP_PATH: Type.String({ minLength: 1 }),
  S3_ENDPOINT: Type.String(),
  S3_REGION: Type.String({ minLength: 1 }),
  S3_BUCKET: Type.String(),
  S3_ACCESS_KEY_ID: Type.String(),
  S3_SECRET_ACCESS_KEY: Type.String(),
  S3_FORCE_PATH_STYLE: Type.Boolean(),
  MAX_OBJECT_BYTES: Type.Integer({ minimum: 1 }),
  MAX_REQUEST_BYTES: Type.Integer({ minimum: 1024 * 1024 }),
  MAX_BLOB_BYTES: Type.Integer({ minimum: 1 }),
  BLOB_PART_BYTES: Type.Integer({ minimum: 1024 * 1024 }),
  CHANGE_RETENTION_DAYS: Type.Integer({ minimum: 1 }),
  VERSION_RETENTION_DAYS: Type.Integer({ minimum: 1 }),
  TOMBSTONE_RETENTION_DAYS: Type.Integer({ minimum: 1 }),
  LOG_LEVEL: Type.Union([
    Type.Literal('fatal'), Type.Literal('error'), Type.Literal('warn'), Type.Literal('info'),
    Type.Literal('debug'), Type.Literal('trace'), Type.Literal('silent'),
  ]),
  METRICS_ENABLED: Type.Boolean(),
  METRICS_TOKEN: Type.String(),
  OPENAPI_ENABLED: Type.Boolean(),
  CORS_ORIGINS: Type.Array(Type.String()),
  WEB_ENABLED: Type.Boolean(),
  WEB_DIST_PATH: Type.String({ minLength: 1 }),
  WEB_PUBLIC_BASE_URL: Type.String({ minLength: 1 }),
  DEPLOYMENT_MODE: Type.Union([Type.Literal('self-hosted'), Type.Literal('hosted')]),
})

type Environment = Static<typeof EnvironmentSchema>

export interface AppConfig {
  readonly nodeEnv: Environment['NODE_ENV']
  readonly host: string
  readonly port: number
  readonly databaseUrl: string
  readonly databasePoolSize: number
  readonly publicBaseUrl: string
  readonly serverName: string
  readonly trustProxy: boolean
  readonly authSecret: string
  readonly setupToken: string
  readonly registrationMode: Environment['REGISTRATION_MODE']
  readonly blobStorageDriver: Environment['BLOB_STORAGE_DRIVER']
  readonly blobStoragePath: string
  readonly backupPath: string
  readonly s3Endpoint: string
  readonly s3Region: string
  readonly s3Bucket: string
  readonly s3AccessKeyId: string
  readonly s3SecretAccessKey: string
  readonly s3ForcePathStyle: boolean
  readonly maxObjectBytes: number
  readonly maxRequestBytes: number
  readonly maxBlobBytes: number
  readonly blobPartBytes: number
  readonly changeRetentionDays: number
  readonly versionRetentionDays: number
  readonly tombstoneRetentionDays: number
  readonly logLevel: Environment['LOG_LEVEL']
  readonly metricsEnabled: boolean
  readonly metricsToken: string
  readonly openApiEnabled: boolean
  readonly corsOrigins: string[]
  readonly webEnabled: boolean
  readonly webDistPath: string
  readonly webPublicBaseUrl: string
  readonly deploymentMode: Environment['DEPLOYMENT_MODE']
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN
}

function developmentWebOrigins(): string[] {
  const hosts = new Set(['127.0.0.1', 'localhost'])

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) hosts.add(address.address)
    }
  }

  return [...hosts].map((host) => `http://${host}:3790`)
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = environment.NODE_ENV === 'production' || environment.NODE_ENV === 'test'
    ? environment.NODE_ENV
    : 'development'
  const configuredCorsOrigins = (environment.CORS_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const corsOrigins = nodeEnv === 'development'
    ? [...new Set([...configuredCorsOrigins, ...developmentWebOrigins()])]
    : configuredCorsOrigins

  const candidate: Environment = {
    NODE_ENV: nodeEnv,
    HOST: environment.HOST ?? '0.0.0.0',
    PORT: integer(environment.PORT, 3789),
    DATABASE_URL: environment.DATABASE_URL ?? 'postgresql://notegen:notegen@localhost:5432/notegen',
    DATABASE_POOL_SIZE: integer(environment.DATABASE_POOL_SIZE, 10),
    PUBLIC_BASE_URL: environment.PUBLIC_BASE_URL ?? 'http://localhost:3789',
    SERVER_NAME: environment.SERVER_NAME?.trim() || 'NoteGen Sync Server',
    TRUST_PROXY: environment.TRUST_PROXY === 'true',
    AUTH_SECRET: environment.AUTH_SECRET ?? 'development-only-auth-secret-change-me',
    SETUP_TOKEN: environment.SETUP_TOKEN ?? 'development-setup-token',
    REGISTRATION_MODE: environment.REGISTRATION_MODE === 'open' ? 'open' : 'closed',
    BLOB_STORAGE_DRIVER: environment.BLOB_STORAGE_DRIVER === 's3' ? 's3' : 'filesystem',
    BLOB_STORAGE_PATH: environment.BLOB_STORAGE_PATH ?? './data/blobs',
    BACKUP_PATH: environment.BACKUP_PATH ?? './data/backups',
    S3_ENDPOINT: environment.S3_ENDPOINT ?? '',
    S3_REGION: environment.S3_REGION ?? 'us-east-1',
    S3_BUCKET: environment.S3_BUCKET ?? '',
    S3_ACCESS_KEY_ID: environment.S3_ACCESS_KEY_ID ?? '',
    S3_SECRET_ACCESS_KEY: environment.S3_SECRET_ACCESS_KEY ?? '',
    S3_FORCE_PATH_STYLE: environment.S3_FORCE_PATH_STYLE !== 'false',
    MAX_OBJECT_BYTES: integer(environment.MAX_OBJECT_BYTES, 2 * 1024 * 1024),
    MAX_REQUEST_BYTES: integer(environment.MAX_REQUEST_BYTES, 16 * 1024 * 1024),
    MAX_BLOB_BYTES: integer(environment.MAX_BLOB_BYTES, 2 * 1024 * 1024 * 1024),
    BLOB_PART_BYTES: integer(environment.BLOB_PART_BYTES, 8 * 1024 * 1024),
    CHANGE_RETENTION_DAYS: integer(environment.CHANGE_RETENTION_DAYS, 90),
    VERSION_RETENTION_DAYS: integer(environment.VERSION_RETENTION_DAYS, 90),
    TOMBSTONE_RETENTION_DAYS: integer(environment.TOMBSTONE_RETENTION_DAYS, 90),
    LOG_LEVEL: isLogLevel(environment.LOG_LEVEL) ? environment.LOG_LEVEL : 'info',
    METRICS_ENABLED: environment.METRICS_ENABLED === 'true'
      || (environment.METRICS_ENABLED !== 'false' && nodeEnv === 'development'),
    METRICS_TOKEN: environment.METRICS_TOKEN?.trim() ?? '',
    OPENAPI_ENABLED: environment.OPENAPI_ENABLED === 'true'
      || (environment.OPENAPI_ENABLED !== 'false' && nodeEnv === 'development'),
    CORS_ORIGINS: corsOrigins,
    WEB_ENABLED: environment.WEB_ENABLED !== 'false',
    WEB_DIST_PATH: environment.WEB_DIST_PATH ?? fileURLToPath(new URL('../../web/out', import.meta.url)),
    WEB_PUBLIC_BASE_URL: environment.WEB_PUBLIC_BASE_URL?.trim()
      || (nodeEnv === 'development' ? 'http://127.0.0.1:3790' : environment.PUBLIC_BASE_URL ?? 'http://localhost:3789'),
    DEPLOYMENT_MODE: environment.DEPLOYMENT_MODE === 'hosted' ? 'hosted' : 'self-hosted',
  }

  if (!Value.Check(EnvironmentSchema, candidate)) {
    const errors = [...Value.Errors(EnvironmentSchema, candidate)]
      .map((error) => `${error.path || '/'} ${error.message}`)
      .join('; ')
    throw new Error(`Invalid server configuration: ${errors}`)
  }

  if (candidate.NODE_ENV === 'production' && candidate.AUTH_SECRET === 'development-only-auth-secret-change-me') {
    throw new Error('AUTH_SECRET must be explicitly configured in production')
  }
  if (candidate.NODE_ENV === 'production' && candidate.SETUP_TOKEN === 'development-setup-token') {
    throw new Error('SETUP_TOKEN must be explicitly configured in production')
  }

  let publicUrl: URL
  let webPublicUrl: URL
  try {
    publicUrl = new URL(candidate.PUBLIC_BASE_URL)
    webPublicUrl = new URL(candidate.WEB_PUBLIC_BASE_URL)
  } catch {
    throw new Error('Invalid server configuration: PUBLIC_BASE_URL and WEB_PUBLIC_BASE_URL must be absolute URLs')
  }
  if ((webPublicUrl.protocol !== 'http:' && webPublicUrl.protocol !== 'https:')
    || webPublicUrl.username.length > 0 || webPublicUrl.password.length > 0
    || webPublicUrl.pathname !== '/' || webPublicUrl.search.length > 0 || webPublicUrl.hash.length > 0) {
    throw new Error('Invalid server configuration: WEB_PUBLIC_BASE_URL must be an HTTP(S) origin without path or credentials')
  }
  if ((publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:')
    || publicUrl.username.length > 0 || publicUrl.password.length > 0
    || publicUrl.pathname !== '/' || publicUrl.search.length > 0 || publicUrl.hash.length > 0) {
    throw new Error('Invalid server configuration: PUBLIC_BASE_URL must be an HTTP(S) origin without path or credentials')
  }
  if (candidate.BLOB_STORAGE_DRIVER === 's3'
    && (candidate.S3_BUCKET.length === 0 || candidate.S3_ACCESS_KEY_ID.length === 0
      || candidate.S3_SECRET_ACCESS_KEY.length === 0)) {
    throw new Error('Invalid server configuration: S3 bucket and credentials are required for the s3 driver')
  }
  if (candidate.BLOB_STORAGE_DRIVER === 's3' && candidate.BLOB_PART_BYTES < 5 * 1024 * 1024) {
    throw new Error('Invalid server configuration: S3 multipart uploads require BLOB_PART_BYTES >= 5242880')
  }
  if (candidate.VERSION_RETENTION_DAYS < candidate.CHANGE_RETENTION_DAYS) {
    throw new Error('Invalid server configuration: VERSION_RETENTION_DAYS must be >= CHANGE_RETENTION_DAYS')
  }
  if (candidate.MAX_BLOB_BYTES > candidate.BLOB_PART_BYTES * 10_000) {
    throw new Error('Invalid server configuration: MAX_BLOB_BYTES exceeds the 10000-part upload limit')
  }

  return {
    nodeEnv: candidate.NODE_ENV,
    host: candidate.HOST,
    port: candidate.PORT,
    databaseUrl: candidate.DATABASE_URL,
    databasePoolSize: candidate.DATABASE_POOL_SIZE,
    publicBaseUrl: publicUrl.origin,
    serverName: candidate.SERVER_NAME,
    trustProxy: candidate.TRUST_PROXY,
    authSecret: candidate.AUTH_SECRET,
    setupToken: candidate.SETUP_TOKEN,
    registrationMode: candidate.REGISTRATION_MODE,
    blobStorageDriver: candidate.BLOB_STORAGE_DRIVER,
    blobStoragePath: candidate.BLOB_STORAGE_PATH,
    backupPath: candidate.BACKUP_PATH,
    s3Endpoint: candidate.S3_ENDPOINT,
    s3Region: candidate.S3_REGION,
    s3Bucket: candidate.S3_BUCKET,
    s3AccessKeyId: candidate.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: candidate.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: candidate.S3_FORCE_PATH_STYLE,
    maxObjectBytes: candidate.MAX_OBJECT_BYTES,
    maxRequestBytes: candidate.MAX_REQUEST_BYTES,
    maxBlobBytes: candidate.MAX_BLOB_BYTES,
    blobPartBytes: candidate.BLOB_PART_BYTES,
    changeRetentionDays: candidate.CHANGE_RETENTION_DAYS,
    versionRetentionDays: candidate.VERSION_RETENTION_DAYS,
    tombstoneRetentionDays: candidate.TOMBSTONE_RETENTION_DAYS,
    logLevel: candidate.LOG_LEVEL,
    metricsEnabled: candidate.METRICS_ENABLED,
    metricsToken: candidate.METRICS_TOKEN,
    openApiEnabled: candidate.OPENAPI_ENABLED,
    corsOrigins: candidate.CORS_ORIGINS,
    webEnabled: candidate.WEB_ENABLED,
    webDistPath: candidate.WEB_DIST_PATH,
    webPublicBaseUrl: webPublicUrl.origin,
    deploymentMode: candidate.DEPLOYMENT_MODE,
  }
}

function isLogLevel(value: string | undefined): value is Environment['LOG_LEVEL'] {
  return value === 'fatal' || value === 'error' || value === 'warn' || value === 'info'
    || value === 'debug' || value === 'trace' || value === 'silent'
}
