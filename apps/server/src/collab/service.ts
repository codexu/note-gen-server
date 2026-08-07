import type { Sql } from 'postgres'
import type { DatabaseContext } from '../database/client.js'
import type { WorkspaceService } from '../workspaces/service.js'

const channel = 'notegen_collaboration_updates'
const maxUpdateBytes = 2 * 1024 * 1024

export interface CollaborationUpdate {
  id: string
  update: string
}

type UpdateListener = (update: CollaborationUpdate) => void
type AwarenessListener = (payload: { clientId: string, state: string }) => void

interface StoredUpdatePayload {
  workspaceId: string
  documentId: string
  updateId: string
}

export class CollaborationService {
  readonly #listeners = new Map<string, Set<UpdateListener>>()
  readonly #awarenessListeners = new Map<string, Set<AwarenessListener>>()
  #listen: Awaited<ReturnType<Sql['listen']>> | undefined

  constructor(
    private readonly database: DatabaseContext,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async initialize(): Promise<void> {
    if (this.#listen !== undefined) return
    this.#listen = await this.database.sql.listen(channel, (payload) => {
      void this.#dispatchStoredUpdate(payload)
    })
  }

  async close(): Promise<void> {
    await this.#listen?.unlisten()
    this.#listen = undefined
    this.#listeners.clear()
    this.#awarenessListeners.clear()
  }

  async load(
    accountId: string,
    workspaceId: string,
    documentId: string,
  ): Promise<CollaborationUpdate[]> {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    const rows = await this.database.sql<{
      id: string
      update: Buffer
    }[]>`
      select id::text, update_payload as update
      from collaboration_updates
      where workspace_id = ${workspaceId} and document_id = ${documentId}
      order by id asc
    `
    return rows.map(row => ({ id: row.id, update: row.update.toString('base64url') }))
  }

  async append(
    accountId: string,
    deviceId: string,
    workspaceId: string,
    documentId: string,
    encodedUpdate: string,
    checkpoint = false,
  ): Promise<CollaborationUpdate> {
    await this.workspaceService.assertOwned(accountId, workspaceId)
    if (!/^[A-Za-z0-9_-]+$/.test(encodedUpdate)) {
      throw new Error('Collaboration update is not valid base64url')
    }
    const update = Buffer.from(encodedUpdate, 'base64url')
    if (update.byteLength === 0 || update.byteLength > maxUpdateBytes) {
      throw new Error('Collaboration update exceeds the configured limit')
    }
    if (checkpoint) {
      await this.database.sql`
        delete from collaboration_updates
        where workspace_id = ${workspaceId} and document_id = ${documentId}
      `
    }
    const [row] = await this.database.sql<{
      id: string
    }[]>`
      insert into collaboration_updates (
        workspace_id, document_id, source_device_id, update_payload
      ) values (
        ${workspaceId}, ${documentId}, ${deviceId}, ${update}
      )
      returning id::text
    `
    if (row === undefined) throw new Error('Collaboration update insert returned no row')
    await this.database.sql.notify(channel, JSON.stringify({
      workspaceId,
      documentId,
      updateId: row.id,
    } satisfies StoredUpdatePayload))
    return { id: row.id, update: encodedUpdate }
  }

  broadcastAwareness(
    workspaceId: string,
    documentId: string,
    clientId: string,
    state: string,
  ): void {
    const key = `${workspaceId}:${documentId}`
    for (const listener of this.#awarenessListeners.get(key) ?? []) listener({ clientId, state })
  }

  subscribeAwareness(
    workspaceId: string,
    documentId: string,
    listener: AwarenessListener,
  ): () => void {
    const key = `${workspaceId}:${documentId}`
    const listeners = this.#awarenessListeners.get(key) ?? new Set<AwarenessListener>()
    listeners.add(listener)
    this.#awarenessListeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#awarenessListeners.delete(key)
    }
  }

  subscribe(
    workspaceId: string,
    documentId: string,
    listener: UpdateListener,
  ): () => void {
    const key = `${workspaceId}:${documentId}`
    const listeners = this.#listeners.get(key) ?? new Set<UpdateListener>()
    listeners.add(listener)
    this.#listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(key)
    }
  }

  async #dispatchStoredUpdate(payload: string): Promise<void> {
    let value: StoredUpdatePayload
    try {
      value = JSON.parse(payload) as StoredUpdatePayload
    } catch {
      return
    }
    if (typeof value.workspaceId !== 'string'
      || typeof value.documentId !== 'string'
      || typeof value.updateId !== 'string') return
    const [row] = await this.database.sql<{
      update: Buffer
    }[]>`
      select update_payload as update
      from collaboration_updates
      where id = ${value.updateId}::bigint
        and workspace_id = ${value.workspaceId}
        and document_id = ${value.documentId}
      limit 1
    `
    if (row === undefined) return
    const key = `${value.workspaceId}:${value.documentId}`
    const update = { id: value.updateId, update: row.update.toString('base64url') }
    for (const listener of this.#listeners.get(key) ?? []) listener(update)
  }
}
