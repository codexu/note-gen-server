import type { SyncObjectKind } from '../sync/types.js'

export interface CiphertextEnvelope {
  keyVersion: number
  ciphertext: string
  ciphertextHash: string
}

export type SyncCommand =
  | ({
      type: 'upsert-object'
      commandId: string
      objectId: string
      kind: SyncObjectKind
      parentObjectId?: string | null
      nameCiphertext?: string | null
      nameBlindIndex?: string | null
      nameBlindIndexKeyVersion?: number
      nameConflictId?: string
      nameConflictCiphertext?: string
      nameConflictCiphertextHash?: string
      baseRevision: string | null
      blobRefs: string[]
      resourceObjectIds?: string[]
    } & CiphertextEnvelope)
  | ({
      type: 'delete-object'
      commandId: string
      objectId: string
      kind: SyncObjectKind
      parentObjectId?: string | null
      nameCiphertext?: string | null
      baseRevision: string
      expectedDocumentSequence: string
      blobRefs: string[]
      conflictId: string
      conflictCiphertext: string
      conflictCiphertextHash: string
    } & CiphertextEnvelope)
  | {
      type: 'delete-subtree'
      commandId: string
      rootObjectId: string
      conflictId: string
      conflictKeyVersion: number
      conflictCiphertext: string
      conflictCiphertextHash: string
      mutationIds?: string[]
      objects: Array<{
        objectId: string
        kind: SyncObjectKind
        baseRevision: string
        expectedDocumentSequence: string
        blobRefs: string[]
      } & CiphertextEnvelope>
    }
  | ({
      type: 'append-update'
      commandId: string
      updateId: string
      documentId: string
      objectId: string
      kind: SyncObjectKind
    } & CiphertextEnvelope)
  | ({
      type: 'commit-checkpoint'
      commandId: string
      checkpointId: string
      documentId: string
      objectId: string
      kind: SyncObjectKind
      coversDocumentSequence: string
      materializedRevision: string | null
    } & CiphertextEnvelope)
  | ({
      type: 'create-conflict'
      commandId: string
      conflictId: string
      objectId: string
      kind: SyncObjectKind
      conflictType: string
      expectedRevision: string | null
      expectedDocumentSequence: string | null
    } & CiphertextEnvelope)
  | {
      type: 'resolve-conflict'
      commandId: string
      conflictId: string
      expectedCreatedSequence: string
      requiresCommandId?: string
      deleteObject?: boolean
      objectResolution?: ({
        objectId: string
        kind: SyncObjectKind
        parentObjectId?: string | null
        nameCiphertext?: string | null
        nameBlindIndex?: string | null
        nameBlindIndexKeyVersion?: number
        blobRefs?: string[]
        resourceObjectIds?: string[]
      } & CiphertextEnvelope)
      resolution?: {
        checkpointId: string
        documentId: string
        objectId: string
        kind: SyncObjectKind
        expectedDocumentSequence: string
      } & CiphertextEnvelope
    }

export type SyncCommandResult = {
  commandId: string
  status: 'applied' | 'conflict' | 'rejected'
  duplicate: boolean
  sequence?: string
  revision?: string
  documentSequence?: string
  conflictId?: string
  code?: string
  retryable?: boolean
  details?: Record<string, unknown>
}
