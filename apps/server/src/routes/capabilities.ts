import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import type { ServiceDependencies } from '../services.js'
import { resolveApiPublicBaseUrl, resolveWebPublicBaseUrl } from '../development-origin.js'

const CapabilitiesResponse = Type.Object({
  service: Type.Literal('note-gen-server'),
  instanceId: Type.String({ format: 'uuid' }),
  serverName: Type.String(),
  serverVersion: Type.String(),
  serverTime: Type.String({ format: 'date-time' }),
  publicBaseUrl: Type.String({ format: 'uri' }),
  protocol: Type.Object({ minimum: Type.Integer(), maximum: Type.Integer() }),
  features: Type.Object({
    deltaSync: Type.Boolean(),
    webSocketWakeUp: Type.Boolean(),
    endToEndEncryption: Type.Boolean(),
    managedDefaultWorkspace: Type.Boolean(),
    blobUpload: Type.Boolean(),
    yjsUpdates: Type.Boolean(),
    settingsSync: Type.Boolean(),
    resumableBlobUploads: Type.Boolean(),
    deviceKeyEnvelopes: Type.Boolean(),
    multiInstanceNotifications: Type.Boolean(),
    workspaceRestore: Type.Boolean(),
    accountDeletion: Type.Boolean(),
    accountWorkspaceNotifications: Type.Boolean(),
    webAccountPortal: Type.Boolean(),
    deviceAuthorization: Type.Boolean(),
    devicePairing: Type.Boolean(),
    manualDeviceToken: Type.Boolean(),
    collaboration: Type.Literal(true),
    collaborationAwareness: Type.Boolean(),
    durableCrdtUpdates: Type.Boolean(),
    synchronizedConflicts: Type.Boolean(),
    assetObjects: Type.Boolean(),
  }),
  limits: Type.Object({
    maxBatchOperations: Type.Integer(),
    maxObjectBytes: Type.Integer(),
    maxRequestBytes: Type.Integer(),
    maxBlobBytes: Type.Integer(),
    blobPartBytes: Type.Integer(),
    maxWorkspaceSubscriptions: Type.Integer(),
    bootstrapSessionTtlSeconds: Type.Integer(),
    changeRetentionDays: Type.Integer(),
    versionRetentionDays: Type.Integer(),
    tombstoneRetentionDays: Type.Integer(),
  }),
  registrationMode: Type.Union([Type.Literal('closed'), Type.Literal('open')]),
  deploymentMode: Type.Union([Type.Literal('self-hosted'), Type.Literal('hosted')]),
  web: Type.Object({
    accountUrl: Type.String({ format: 'uri' }),
    deviceAuthorizationUrl: Type.String({ format: 'uri' }),
  }),
})

export function createCapabilitiesRoutes(
  config: AppConfig,
  dependencies: ServiceDependencies,
): FastifyPluginAsyncTypebox {
  return async function capabilitiesRoutes(app) {
    app.get('/v1/capabilities', {
      schema: { response: { 200: CapabilitiesResponse } },
    }, async (request) => {
      const webPublicBaseUrl = resolveWebPublicBaseUrl(config, request)
      return {
      service: 'note-gen-server' as const,
      instanceId: dependencies.instanceId,
      serverName: config.serverName,
      serverVersion: dependencies.version,
      serverTime: new Date().toISOString(),
      publicBaseUrl: resolveApiPublicBaseUrl(config, request),
      protocol: { minimum: 1, maximum: 1 },
      features: {
        deltaSync: true,
        webSocketWakeUp: true,
        endToEndEncryption: true,
        managedDefaultWorkspace: true,
        blobUpload: true,
        yjsUpdates: true,
        settingsSync: true,
        resumableBlobUploads: true,
        deviceKeyEnvelopes: true,
        multiInstanceNotifications: true,
        workspaceRestore: true,
        accountDeletion: true,
        accountWorkspaceNotifications: true,
        webAccountPortal: config.webEnabled,
        deviceAuthorization: true,
        devicePairing: config.webEnabled,
        manualDeviceToken: false,
        collaboration: true as const,
        collaborationAwareness: false,
        durableCrdtUpdates: true,
        synchronizedConflicts: true,
        assetObjects: true,
      },
      limits: {
        maxBatchOperations: 100,
        maxObjectBytes: config.maxObjectBytes,
        maxRequestBytes: config.maxRequestBytes,
        maxBlobBytes: config.maxBlobBytes,
        blobPartBytes: config.blobPartBytes,
        maxWorkspaceSubscriptions: 100,
        bootstrapSessionTtlSeconds: 1_800,
        changeRetentionDays: config.changeRetentionDays,
        versionRetentionDays: config.versionRetentionDays,
        tombstoneRetentionDays: config.tombstoneRetentionDays,
      },
      registrationMode: config.registrationMode,
      deploymentMode: config.deploymentMode,
      web: {
        accountUrl: `${webPublicBaseUrl}/`,
        deviceAuthorizationUrl: `${webPublicBaseUrl}/connect/`,
      },
      }
    })
  }
}
