import type { Sql } from 'postgres'
import type { ChangeNotifier, SyncNotice } from './types.js'

type Listener = (notice: SyncNotice) => void
const channel = 'notegen_sync_changes'

export class InMemoryChangeNotifier implements ChangeNotifier {
  readonly #listeners = new Map<string, Set<Listener>>()

  async publish(notice: SyncNotice): Promise<void> {
    this.#dispatch(notice)
  }

  subscribeWorkspace(workspaceId: string, listener: Listener): () => void {
    return this.#subscribe(`workspace:${workspaceId}`, listener)
  }

  subscribeAccount(accountId: string, listener: Listener): () => void {
    return this.#subscribe(`account:${accountId}`, listener)
  }

  #subscribe(scope: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(scope) ?? new Set<Listener>()
    listeners.add(listener)
    this.#listeners.set(scope, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(scope)
    }
  }

  async close(): Promise<void> {
    this.#listeners.clear()
  }

  protected dispatch(notice: SyncNotice): void {
    this.#dispatch(notice)
  }

  #dispatch(notice: SyncNotice): void {
    const scope = notice.type === 'account.workspaces-changed'
      ? `account:${notice.accountId}`
      : `workspace:${notice.workspaceId}`
    for (const listener of this.#listeners.get(scope) ?? []) listener(notice)
  }
}

export class PostgresChangeNotifier extends InMemoryChangeNotifier {
  #listen: Awaited<ReturnType<Sql['listen']>> | undefined

  constructor(private readonly sql: Sql) {
    super()
  }

  async initialize(): Promise<void> {
    if (this.#listen !== undefined) return
    this.#listen = await this.sql.listen(channel, (payload) => {
      const notice = parseNotice(payload)
      if (notice !== null) this.dispatch(notice)
    })
  }

  override async publish(notice: SyncNotice): Promise<void> {
    await this.sql.notify(channel, JSON.stringify(notice))
  }

  override async close(): Promise<void> {
    await this.#listen?.unlisten()
    this.#listen = undefined
    await super.close()
  }
}

function parseNotice(payload: string): SyncNotice | null {
  try {
    const value: unknown = JSON.parse(payload)
    if (typeof value !== 'object' || value === null) return null
    const candidate = value as Record<string, unknown>
    if (candidate.type === 'account.workspaces-changed' && typeof candidate.accountId === 'string') {
      return { type: 'account.workspaces-changed', accountId: candidate.accountId }
    }
    if (typeof candidate.workspaceId !== 'string') return null
    if (candidate.type === 'workspace.changed' && typeof candidate.latestSequence === 'string'
      && /^\d+$/.test(candidate.latestSequence)) {
      return { type: 'workspace.changed', workspaceId: candidate.workspaceId, latestSequence: candidate.latestSequence }
    }
    if (candidate.type === 'workspace.keys-changed' && typeof candidate.keyVersion === 'number'
      && Number.isSafeInteger(candidate.keyVersion) && candidate.keyVersion > 0) {
      return { type: 'workspace.keys-changed', workspaceId: candidate.workspaceId, keyVersion: candidate.keyVersion }
    }
    if (candidate.type === 'workspace.state-changed' && typeof candidate.deleted === 'boolean') {
      return { type: 'workspace.state-changed', workspaceId: candidate.workspaceId, deleted: candidate.deleted }
    }
    return null
  } catch {
    return null
  }
}
