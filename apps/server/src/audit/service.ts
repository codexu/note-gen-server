import type { DatabaseContext } from '../database/client.js'
import { accountServiceAuditEvents } from '../database/schema.js'

export type AccountServiceAuditActorType = 'account' | 'staff' | 'system' | 'webhook'

export interface AccountServiceAuditEvent {
  actorType: AccountServiceAuditActorType
  actorId?: string
  action: string
  targetType: string
  targetId?: string
  requestId?: string
  /** Enum/count/reference facts only; caller must never place plaintext PII or secrets here. */
  metadata?: Record<string, unknown>
}

/** Shared append-only actor audit surface for account, staff, system and webhook work. */
export class AccountServiceAudit {
  constructor(private readonly database: DatabaseContext) {}

  async record(event: AccountServiceAuditEvent): Promise<void> {
    await this.recordInTransaction(this.database.db, event)
  }

  async recordInTransaction(tx: any, event: AccountServiceAuditEvent): Promise<void> {
    await tx.insert(accountServiceAuditEvents).values({
      actorType: event.actorType, ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
      action: event.action, targetType: event.targetType,
      ...(event.targetId === undefined ? {} : { targetId: event.targetId }),
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      metadata: event.metadata ?? {},
    })
  }
}
