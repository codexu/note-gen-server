import { Type } from '@sinclair/typebox'
export const Timestamp = Type.Unsafe<Date>({ type: 'string', format: 'date-time' })
export const NullableTimestamp = Type.Union([Timestamp, Type.Null()])
export const CounterString = Type.String({ pattern: '^\\d{1,19}$' })
export const HashString = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })
export const SessionResponse = Type.Object({
  accountId: Type.String({ format: 'uuid' }),
  deviceId: Type.String({ format: 'uuid' }),
  accessToken: Type.String(),
  refreshToken: Type.String(),
  accessTokenExpiresIn: Type.Integer(),
})
export const SyncObjectKindSchema = Type.Union([
  Type.Literal('note'),
  Type.Literal('folder'),
  Type.Literal('asset'),
  Type.Literal('canvas'),
  Type.Literal('record'),
  Type.Literal('tag'),
  Type.Literal('mark'),
  Type.Literal('conversation'),
  Type.Literal('memory'),
  Type.Literal('setting'),
  Type.Literal('yjs-checkpoint'),
  Type.Literal('yjs-update'),
])

export const KeyEnvelopeResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  keyVersion: Type.Integer(),
  type: Type.Union([Type.Literal('passphrase'), Type.Literal('recovery'), Type.Literal('device'), Type.Literal('managed')]),
  recipientId: Type.Union([Type.String(), Type.Null()]),
  wrappedKey: Type.String(),
  kdfSalt: Type.Union([Type.String(), Type.Null()]),
  kdfParams: Type.Union([Type.Record(Type.String(), Type.Number()), Type.Null()]),
  createdAt: Timestamp,
})

export const CurrentObjectResponse = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  objectId: Type.String({ format: 'uuid' }),
  kind: SyncObjectKindSchema,
  currentRevision: CounterString,
  ciphertext: Type.String(),
  ciphertextHash: HashString,
  keyVersion: Type.Integer(),
  blobRefs: Type.Array(HashString),
  deletedAt: NullableTimestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export const PushResultResponse = Type.Union([
  Type.Object({
    operationId: Type.String({ format: 'uuid' }),
    status: Type.Literal('applied'),
    revision: CounterString,
    sequence: CounterString,
    duplicate: Type.Boolean(),
  }),
  Type.Object({
    operationId: Type.String({ format: 'uuid' }),
    status: Type.Literal('conflict'),
    code: Type.Literal('revision_conflict'),
    current: Type.Union([CurrentObjectResponse, Type.Null()]),
  }),
  Type.Object({
    operationId: Type.String({ format: 'uuid' }),
    status: Type.Literal('rejected'),
    code: Type.String(),
    retryable: Type.Boolean(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
])

export const PushResponse = Type.Object({ results: Type.Array(PushResultResponse) })

export const ChangeResponse = Type.Object({
  sequence: CounterString,
  objectId: Type.String({ format: 'uuid' }),
  revision: CounterString,
  operationId: Type.String({ format: 'uuid' }),
  sourceDeviceId: Type.String({ format: 'uuid' }),
  changeType: Type.Union([Type.Literal('upsert'), Type.Literal('delete')]),
  kind: SyncObjectKindSchema,
  ciphertext: Type.String(),
  ciphertextHash: HashString,
  keyVersion: Type.Integer(),
  blobRefs: Type.Array(HashString),
  deleted: Type.Boolean(),
  createdAt: Timestamp,
})

export const BootstrapObjectResponse = Type.Object({
  objectId: Type.String({ format: 'uuid' }),
  currentRevision: CounterString,
  kind: SyncObjectKindSchema,
  ciphertext: Type.String(),
  ciphertextHash: HashString,
  keyVersion: Type.Integer(),
  blobRefs: Type.Array(HashString),
  deletedAt: NullableTimestamp,
})

export const ObjectVersionResponse = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  objectId: Type.String({ format: 'uuid' }),
  revision: CounterString,
  sequence: CounterString,
  kind: SyncObjectKindSchema,
  ciphertext: Type.String(),
  ciphertextHash: HashString,
  keyVersion: Type.Integer(),
  blobRefs: Type.Array(HashString),
  sourceDeviceId: Type.String({ format: 'uuid' }),
  deleted: Type.Boolean(),
  createdAt: Timestamp,
})

export const UploadedPartResponse = Type.Object({
  partNumber: Type.Integer(),
  size: CounterString,
  etag: Type.String(),
})
