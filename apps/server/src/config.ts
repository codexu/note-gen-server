import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
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
  SETUP_TOKEN: Type.String(),
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
  HOSTED_RELEASE_STAGE: Type.Union([Type.Literal('internal-test'), Type.Literal('live')]),
  HOSTED_REGISTRATION_POLICY: Type.Union([Type.Literal('disabled'), Type.Literal('public')]),
  BILLING_PROVIDER: Type.Union([Type.Literal('none'), Type.Literal('mock')]),
  BILLING_PROVIDER_ENVIRONMENT: Type.Union([Type.Literal('test'), Type.Literal('live')]),
  BILLING_MERCHANT_ENTITY: Type.String(),
  HOSTED_MAIL_PROVIDER: Type.Union([Type.Literal('none'), Type.Literal('log')]),
  MAIL_DRIVER: Type.Union([Type.Literal('disabled'), Type.Literal('smtp')]),
  MAIL_FROM_ADDRESS: Type.String(),
  MAIL_FROM_NAME: Type.String({ maxLength: 200 }),
  MAIL_REPLY_TO: Type.String(),
  MAIL_DEFAULT_LOCALE: Type.Union([Type.Literal('en'), Type.Literal('zh-CN')]),
  SMTP_HOST: Type.String(),
  SMTP_PORT: Type.Integer({ minimum: 1, maximum: 65_535 }),
  SMTP_TLS_MODE: Type.Union([Type.Literal('starttls-required'), Type.Literal('starttls'), Type.Literal('tls'), Type.Literal('none')]),
  SMTP_USERNAME: Type.String(),
  SMTP_PASSWORD: Type.String(),
  SMTP_CONNECT_TIMEOUT_MS: Type.Integer({ minimum: 1_000, maximum: 120_000 }),
  SMTP_COMMAND_TIMEOUT_MS: Type.Integer({ minimum: 1_000, maximum: 120_000 }),
  SMTP_TLS_REJECT_UNAUTHORIZED: Type.Boolean(),
  ALLOW_INSECURE_SMTP: Type.Boolean(),
  HOSTED_DATA_REGION: Type.String({ minLength: 1 }),
  PENDING_EMAIL_VERIFICATION_DAYS: Type.Integer({ minimum: 1, maximum: 90 }),
  ACCOUNT_DELETION_COOLING_OFF_DAYS: Type.Integer({ minimum: 1, maximum: 365 }),
  ACCOUNT_DELETION_RETENTION_DAYS: Type.Integer({ minimum: 1, maximum: 3650 }),
  DELETION_LEDGER_PATH: Type.String({ minLength: 1 }),
  LEGAL_HOLD_APPROVAL_AUTHORITY: Type.Literal('platform-admin'),
  USAGE_ENFORCEMENT: Type.Union([Type.Literal('disabled'), Type.Literal('observe'), Type.Literal('hard')]),
  CAPABILITIES_ENABLE: Type.Array(Type.String()),
  CAPABILITIES_DISABLE: Type.Array(Type.String()),
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
  /** Internal-test is deliberately the default: no hosted capability is a production launch signal. */
  readonly hostedReleaseStage: Environment['HOSTED_RELEASE_STAGE']
  /** Internal-test-only override for the otherwise control-plane-managed hosted signup policy. */
  readonly hostedRegistrationPolicy: Extract<Environment['HOSTED_REGISTRATION_POLICY'], 'disabled' | 'public'>
  /** Provider-neutral test seam. `mock` never creates a real charge or customer. */
  readonly billingProvider: Environment['BILLING_PROVIDER']
  readonly billingProviderEnvironment: Environment['BILLING_PROVIDER_ENVIRONMENT']
  readonly billingMerchantEntity: string
  /** `log` is a redacted local sink and must never deliver email externally. */
  readonly hostedMailProvider: Environment['HOSTED_MAIL_PROVIDER']
  /** Seeded from legacy env once, then managed by the encrypted runtime configuration store. */
  readonly mailDriver: Environment['MAIL_DRIVER']
  readonly mailFromAddress: string
  readonly mailFromName: string
  readonly mailReplyTo: string
  readonly mailDefaultLocale: Environment['MAIL_DEFAULT_LOCALE']
  readonly smtpHost: string
  readonly smtpPort: number
  readonly smtpTlsMode: Environment['SMTP_TLS_MODE']
  readonly smtpUsername: string
  readonly smtpPassword: string
  readonly smtpConnectTimeoutMs: number
  readonly smtpCommandTimeoutMs: number
  readonly smtpTlsRejectUnauthorized: boolean
  readonly hostedDataRegion: string
  /** Pending hosted registrations are non-durable and may be safely pruned after this window. */
  readonly pendingEmailVerificationDays: number
  readonly accountDeletionCoolingOffDays: number
  readonly accountDeletionRetentionDays: number
  /** Separate receipt store used for internal recovery drills; it must not share an application backup path. */
  readonly deletionLedgerPath: string
  readonly legalHoldApprovalAuthority: 'platform-admin'
  /** Commercial counter enforcement is internal-test-only until every writer is fenced. */
  readonly usageEnforcement: Environment['USAGE_ENFORCEMENT']
  readonly capabilitiesEnable: readonly string[]
  readonly capabilitiesDisable: readonly string[]
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
    // Kept as an optional legacy import source for old uninitialized/restore
    // flows. New installations are claimed directly through the Web guide.
    SETUP_TOKEN: environment.SETUP_TOKEN ?? '',
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
    // Deployment behavior is selected by the one-time Web installer. These
    // values are only safe pre-installation defaults and are replaced from DB.
    DEPLOYMENT_MODE: 'self-hosted',
    HOSTED_RELEASE_STAGE: 'internal-test',
    HOSTED_REGISTRATION_POLICY: 'disabled',
    BILLING_PROVIDER: 'none',
    BILLING_PROVIDER_ENVIRONMENT: 'test',
    BILLING_MERCHANT_ENTITY: '',
    HOSTED_MAIL_PROVIDER: 'none',
    MAIL_DRIVER: environment.MAIL_DRIVER === 'smtp' ? 'smtp' : 'disabled',
    MAIL_FROM_ADDRESS: environment.MAIL_FROM_ADDRESS?.trim() ?? '',
    MAIL_FROM_NAME: environment.MAIL_FROM_NAME?.trim() || 'NoteGen',
    MAIL_REPLY_TO: environment.MAIL_REPLY_TO?.trim() ?? '',
    MAIL_DEFAULT_LOCALE: environment.MAIL_DEFAULT_LOCALE === 'en' ? 'en' : 'zh-CN',
    SMTP_HOST: environment.SMTP_HOST?.trim() ?? '',
    SMTP_PORT: integer(environment.SMTP_PORT, 587),
    SMTP_TLS_MODE: environment.SMTP_TLS_MODE === 'tls' ? 'tls'
      : environment.SMTP_TLS_MODE === 'starttls' ? 'starttls'
        : environment.SMTP_TLS_MODE === 'none' ? 'none' : 'starttls-required',
    SMTP_USERNAME: environment.SMTP_USERNAME ?? '',
    SMTP_PASSWORD: environment.SMTP_PASSWORD ?? '',
    SMTP_CONNECT_TIMEOUT_MS: integer(environment.SMTP_CONNECT_TIMEOUT_MS, 10_000),
    SMTP_COMMAND_TIMEOUT_MS: integer(environment.SMTP_COMMAND_TIMEOUT_MS, 15_000),
    SMTP_TLS_REJECT_UNAUTHORIZED: environment.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
    ALLOW_INSECURE_SMTP: environment.ALLOW_INSECURE_SMTP === 'true',
    HOSTED_DATA_REGION: 'local-internal-test',
    PENDING_EMAIL_VERIFICATION_DAYS: integer(environment.PENDING_EMAIL_VERIFICATION_DAYS, 7),
    ACCOUNT_DELETION_COOLING_OFF_DAYS: integer(environment.ACCOUNT_DELETION_COOLING_OFF_DAYS, 30),
    ACCOUNT_DELETION_RETENTION_DAYS: integer(environment.ACCOUNT_DELETION_RETENTION_DAYS, 90),
    DELETION_LEDGER_PATH: environment.DELETION_LEDGER_PATH ?? './data/deletion-ledger',
    LEGAL_HOLD_APPROVAL_AUTHORITY: 'platform-admin',
    USAGE_ENFORCEMENT: 'disabled',
    CAPABILITIES_ENABLE: parseList(environment.CAPABILITIES_ENABLE),
    CAPABILITIES_DISABLE: parseList(environment.CAPABILITIES_DISABLE),
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
  if (candidate.ACCOUNT_DELETION_RETENTION_DAYS < candidate.ACCOUNT_DELETION_COOLING_OFF_DAYS) {
    throw new Error('Invalid server configuration: ACCOUNT_DELETION_RETENTION_DAYS must be >= ACCOUNT_DELETION_COOLING_OFF_DAYS')
  }
  if (candidate.DEPLOYMENT_MODE === 'hosted') {
    const ledgerPath = resolve(candidate.DELETION_LEDGER_PATH)
    if (ledgerPath === resolve(candidate.BACKUP_PATH) || (candidate.BLOB_STORAGE_DRIVER === 'filesystem' && ledgerPath === resolve(candidate.BLOB_STORAGE_PATH))) {
      throw new Error('Invalid server configuration: DELETION_LEDGER_PATH must be separate from backup and blob storage paths')
    }
  }
  if (candidate.DEPLOYMENT_MODE === 'hosted' && candidate.HOSTED_RELEASE_STAGE === 'internal-test'
    && (candidate.BILLING_PROVIDER_ENVIRONMENT !== 'test' || candidate.HOSTED_MAIL_PROVIDER !== 'log')) {
    throw new Error('Invalid server configuration: internal-test requires test billing and the non-delivering log mail provider')
  }
  if (candidate.DEPLOYMENT_MODE === 'hosted' && candidate.HOSTED_RELEASE_STAGE === 'internal-test'
    && (candidate.BILLING_PROVIDER !== 'mock' || candidate.BILLING_MERCHANT_ENTITY !== 'internal-test-only')) {
    throw new Error('Invalid server configuration: hosted internal-test requires the mock provider and internal-test-only merchant entity')
  }
  if (candidate.HOSTED_RELEASE_STAGE === 'live') {
    throw new Error('Hosted live configuration is not supported until a reviewed billing and mail adapter is implemented')
  }
  if (candidate.DEPLOYMENT_MODE === 'hosted' && candidate.MAIL_DRIVER !== 'disabled') {
    throw new Error('Invalid server configuration: hosted mail uses HOSTED_MAIL_PROVIDER, not MAIL_DRIVER')
  }
  if (candidate.MAIL_DRIVER === 'smtp') {
    if (candidate.DEPLOYMENT_MODE !== 'self-hosted' || candidate.SMTP_HOST.length === 0 || !isEmailAddress(candidate.MAIL_FROM_ADDRESS)) {
      throw new Error('Invalid server configuration: self-hosted SMTP requires SMTP_HOST and a valid MAIL_FROM_ADDRESS')
    }
    if ((candidate.SMTP_USERNAME.length === 0) !== (candidate.SMTP_PASSWORD.length === 0)) {
      throw new Error('Invalid server configuration: SMTP_USERNAME and SMTP_PASSWORD must be configured together')
    }
    if ((candidate.SMTP_TLS_MODE === 'none' || !candidate.SMTP_TLS_REJECT_UNAUTHORIZED) && !candidate.ALLOW_INSECURE_SMTP) {
      throw new Error('Invalid server configuration: insecure SMTP requires ALLOW_INSECURE_SMTP=true')
    }
    if (candidate.MAIL_REPLY_TO.length > 0 && !isEmailAddress(candidate.MAIL_REPLY_TO)) {
      throw new Error('Invalid server configuration: MAIL_REPLY_TO must be a valid email address')
    }
  }
  if (candidate.DEPLOYMENT_MODE !== 'hosted' && candidate.USAGE_ENFORCEMENT !== 'disabled') {
    throw new Error('Invalid server configuration: self-hosted usage enforcement must remain disabled')
  }
  if (candidate.USAGE_ENFORCEMENT === 'hard' && candidate.HOSTED_RELEASE_STAGE !== 'internal-test') {
    throw new Error('Invalid server configuration: hard usage enforcement is internal-test-only')
  }
  if (candidate.USAGE_ENFORCEMENT === 'hard' && !candidate.CAPABILITIES_ENABLE.includes('usage.enforcement')) {
    throw new Error('Invalid server configuration: hard usage enforcement requires explicit usage.enforcement capability enablement')
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
    hostedReleaseStage: candidate.HOSTED_RELEASE_STAGE,
    hostedRegistrationPolicy: candidate.HOSTED_REGISTRATION_POLICY,
    billingProvider: candidate.BILLING_PROVIDER,
    billingProviderEnvironment: candidate.BILLING_PROVIDER_ENVIRONMENT,
    billingMerchantEntity: candidate.BILLING_MERCHANT_ENTITY,
    hostedMailProvider: candidate.HOSTED_MAIL_PROVIDER,
    mailDriver: candidate.MAIL_DRIVER,
    mailFromAddress: candidate.MAIL_FROM_ADDRESS,
    mailFromName: candidate.MAIL_FROM_NAME,
    mailReplyTo: candidate.MAIL_REPLY_TO,
    mailDefaultLocale: candidate.MAIL_DEFAULT_LOCALE,
    smtpHost: candidate.SMTP_HOST,
    smtpPort: candidate.SMTP_PORT,
    smtpTlsMode: candidate.SMTP_TLS_MODE,
    smtpUsername: candidate.SMTP_USERNAME,
    smtpPassword: candidate.SMTP_PASSWORD,
    smtpConnectTimeoutMs: candidate.SMTP_CONNECT_TIMEOUT_MS,
    smtpCommandTimeoutMs: candidate.SMTP_COMMAND_TIMEOUT_MS,
    smtpTlsRejectUnauthorized: candidate.SMTP_TLS_REJECT_UNAUTHORIZED,
    hostedDataRegion: candidate.HOSTED_DATA_REGION,
    pendingEmailVerificationDays: candidate.PENDING_EMAIL_VERIFICATION_DAYS,
    accountDeletionCoolingOffDays: candidate.ACCOUNT_DELETION_COOLING_OFF_DAYS,
    accountDeletionRetentionDays: candidate.ACCOUNT_DELETION_RETENTION_DAYS,
    deletionLedgerPath: candidate.DELETION_LEDGER_PATH,
    legalHoldApprovalAuthority: candidate.LEGAL_HOLD_APPROVAL_AUTHORITY,
    usageEnforcement: candidate.USAGE_ENFORCEMENT,
    capabilitiesEnable: candidate.CAPABILITIES_ENABLE,
    capabilitiesDisable: candidate.CAPABILITIES_DISABLE,
  }
}

/** Applies the persisted installation profile before mode-specific services are assembled. */
export function applyPersistedDeploymentProfile(
  config: AppConfig,
  deploymentMode: 'self-hosted',
): void {
  const profile = {
    deploymentMode,
    hostedRegistrationPolicy: 'disabled' as const,
    billingProvider: 'none' as const,
    hostedMailProvider: 'none' as const,
    usageEnforcement: 'disabled' as const,
  }
  Object.assign(config as unknown as Record<string, unknown>, profile)
}

function parseList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function isEmailAddress(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isLogLevel(value: string | undefined): value is Environment['LOG_LEVEL'] {
  return value === 'fatal' || value === 'error' || value === 'warn' || value === 'info'
    || value === 'debug' || value === 'trace' || value === 'silent'
}
