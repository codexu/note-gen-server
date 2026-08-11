import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { accounts, supportCases, supportDiagnosticGrants, supportMessages } from '../database/schema.js'
import { ApiError } from '../errors.js'
import { assertAccountWriteAllowedInTransaction, type DeletionFenceTransaction } from '../compliance/deletion-fence.js'
import type { StaffService } from '../staff/service.js'
import type { AccountServiceAudit } from '../audit/service.js'

export type SupportCategory = 'account' | 'sync' | 'device' | 'encryption' | 'billing' | 'privacy' | 'abuse' | 'other'
export type SupportSeverity = 'normal' | 'high' | 'urgent'

type CreateCaseInput = { accountId: string, category: SupportCategory, severity: SupportSeverity, subject: string, body: string, idempotencyKey: string }
type DiagnosticSummary = { formatVersion: 1, phase: string, pauseReason: string | null, server: { configured: boolean, deploymentMode: 'hosted' | 'self-hosted' | null, serverVersion: string | null, syncEpochKnown: boolean }, queue: Record<'pendingMutations' | 'pendingOutbox' | 'blockedOutbox' | 'pendingInbox' | 'failedInbox' | 'unresolvedConflicts' | 'pendingTransfers' | 'failedTransfers', number> }

/**
 * Customer-side support facts. The independent key derivation makes a support
 * body incompatible with account action tokens and sync ciphertext. This is a
 * local/internal-test key boundary, not a substitute for the future keyring.
 */
export class SupportService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly staff?: StaffService,
    private readonly audit?: AccountServiceAudit,
  ) {}

  async createCase(input: CreateCaseInput): Promise<{ id: string, created: boolean }> {
    this.assertInternalHosted()
    const subject = normalizeSubject(input.subject)
    const body = normalizeBody(input.body)
    const requestInput = `${input.category}\n${input.severity}\n${subject}\n${body}`
    const requestHash = this.requestHash(requestInput)
    const legacyRequestHash = legacyHash(requestInput)
    return await this.database.db.transaction(async (tx) => {
      await this.assertAccountWriteAllowed(tx, input.accountId)
      const [account] = await tx.select({ login: accounts.login }).from(accounts).where(eq(accounts.id, input.accountId)).limit(1)
      if (account === undefined) throw new ApiError({ code: 'account_not_found', message: 'Account was not found', statusCode: 404 })
      const [existing] = await tx.select({ id: supportCases.id, requestHash: supportMessages.requestHash })
        .from(supportMessages).innerJoin(supportCases, eq(supportCases.id, supportMessages.caseId)).where(and(
          eq(supportMessages.authorType, 'account'), eq(supportMessages.authorRef, input.accountId), eq(supportMessages.idempotencyKey, input.idempotencyKey),
        )).limit(1)
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash && existing.requestHash !== legacyRequestHash) throw new ApiError({ code: 'idempotency_conflict', message: 'Support idempotency key was reused with different content', statusCode: 409 })
        return { id: existing.id, created: false }
      }
      const now = new Date()
      const [caseRow] = await tx.insert(supportCases).values({
        accountId: input.accountId, subjectHash: this.subjectHash(input.accountId), accountSnapshot: { loginHash: this.accountLoginHash(account.login) },
        category: input.category, severity: input.severity, status: 'waiting_for_support', subject, source: 'web', lastMessageAt: now,
      }).returning({ id: supportCases.id })
      if (caseRow === undefined) throw new Error('Support case insert returned no row')
      await tx.insert(supportMessages).values({
        caseId: caseRow.id, authorType: 'account', authorRef: input.accountId, visibility: 'customer',
        bodyCiphertext: this.encrypt(caseRow.id, body), bodyKeyId: 'support-aead-v1', bodyEncryptionVersion: 1,
        idempotencyKey: input.idempotencyKey, requestHash,
      })
      return { id: caseRow.id, created: true }
    })
  }

  async listCases(accountId: string) {
    this.assertInternalHosted()
    const rows = await this.database.db.select().from(supportCases).where(eq(supportCases.accountId, accountId)).orderBy(desc(supportCases.updatedAt)).limit(100)
    return rows.map(row => ({ id: row.id, category: row.category, severity: row.severity, status: row.status, subject: row.subject, lastMessageAt: row.lastMessageAt, createdAt: row.createdAt, updatedAt: row.updatedAt }))
  }

  async getCase(accountId: string, caseId: string) {
    this.assertInternalHosted()
    const [caseRow] = await this.database.db.select().from(supportCases).where(and(eq(supportCases.id, caseId), eq(supportCases.accountId, accountId))).limit(1)
    if (caseRow === undefined) throw new ApiError({ code: 'support_case_not_found', message: 'Support case was not found', statusCode: 404 })
    const messages = await this.database.db.select().from(supportMessages).where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.visibility, 'customer'))).orderBy(asc(supportMessages.createdAt))
    return { id: caseRow.id, category: caseRow.category, severity: caseRow.severity, status: caseRow.status, subject: caseRow.subject, lastMessageAt: caseRow.lastMessageAt, createdAt: caseRow.createdAt, updatedAt: caseRow.updatedAt,
      messages: messages.map(message => ({ id: message.id, authorType: message.authorType, body: this.decrypt(caseId, message.bodyCiphertext), createdAt: message.createdAt })) }
  }

  async appendCustomerMessage(accountId: string, caseId: string, body: string, idempotencyKey: string): Promise<{ id: string, created: boolean }> {
    this.assertInternalHosted()
    const plaintext = normalizeBody(body)
    const requestHash = this.requestHash(plaintext)
    const legacyRequestHash = legacyHash(plaintext)
    return await this.database.db.transaction(async (tx) => {
      await this.assertAccountWriteAllowed(tx, accountId)
      const [caseRow] = await tx.select({ id: supportCases.id, status: supportCases.status }).from(supportCases).where(and(eq(supportCases.id, caseId), eq(supportCases.accountId, accountId))).limit(1).for('update')
      if (caseRow === undefined || ['closed', 'spam'].includes(caseRow.status)) throw new ApiError({ code: 'support_case_not_found', message: 'Support case was not found', statusCode: 404 })
      const [existing] = await tx.select({ id: supportMessages.id, requestHash: supportMessages.requestHash }).from(supportMessages).where(and(
        eq(supportMessages.caseId, caseId), eq(supportMessages.authorType, 'account'), eq(supportMessages.idempotencyKey, idempotencyKey),
      )).limit(1)
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash && existing.requestHash !== legacyRequestHash) throw new ApiError({ code: 'idempotency_conflict', message: 'Support idempotency key was reused with different content', statusCode: 409 })
        return { id: existing.id, created: false }
      }
      const now = new Date()
      const [created] = await tx.insert(supportMessages).values({ caseId, authorType: 'account', authorRef: accountId, visibility: 'customer', bodyCiphertext: this.encrypt(caseId, plaintext), bodyKeyId: 'support-aead-v1', bodyEncryptionVersion: 1, idempotencyKey, requestHash }).returning({ id: supportMessages.id })
      if (created === undefined) throw new Error('Support message insert returned no row')
      await tx.update(supportCases).set({ status: 'waiting_for_support', lastMessageAt: now, updatedAt: now }).where(eq(supportCases.id, caseId))
      return { id: created.id, created: true }
    })
  }

  async createDiagnosticGrant(accountId: string, caseId: string, summary: DiagnosticSummary, expiresAt: Date): Promise<{ id: string, expiresAt: Date }> {
    this.assertInternalHosted()
    assertDiagnosticSummary(summary)
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date() || expiresAt.getTime() > Date.now() + 7 * 24 * 60 * 60 * 1_000) throw new ApiError({ code: 'diagnostic_grant_expiry_invalid', message: 'Diagnostic grant expiry must be within seven days', statusCode: 400 })
    return await this.database.db.transaction(async (tx) => {
      await this.assertAccountWriteAllowed(tx, accountId)
      const [caseRow] = await tx.select({ id: supportCases.id }).from(supportCases).where(and(eq(supportCases.id, caseId), eq(supportCases.accountId, accountId))).limit(1).for('update')
      if (caseRow === undefined) throw new ApiError({ code: 'support_case_not_found', message: 'Support case was not found', statusCode: 404 })
      const [created] = await tx.insert(supportDiagnosticGrants).values({ caseId, accountId, scopeVersion: 'sync-summary-v1', snapshotCiphertext: this.encrypt(caseId, JSON.stringify(summary)), snapshotKeyId: 'support-aead-v1', snapshotEncryptionVersion: 1, expiresAt }).returning({ id: supportDiagnosticGrants.id, expiresAt: supportDiagnosticGrants.expiresAt })
      if (created === undefined) throw new Error('Diagnostic grant insert failed')
      return created
    })
  }

  async revokeDiagnosticGrant(accountId: string, caseId: string, grantId: string): Promise<void> {
    this.assertInternalHosted()
    await this.database.db.transaction(async (tx) => {
      await this.assertAccountWriteAllowed(tx, accountId)
      const changed = await tx.update(supportDiagnosticGrants).set({ revokedAt: new Date(), deletedAt: new Date(), snapshotCiphertext: '' })
        .where(and(eq(supportDiagnosticGrants.id, grantId), eq(supportDiagnosticGrants.caseId, caseId), eq(supportDiagnosticGrants.accountId, accountId), sql`${supportDiagnosticGrants.revokedAt} is null`)).returning({ id: supportDiagnosticGrants.id })
      if (changed.length !== 1) throw new ApiError({ code: 'diagnostic_grant_not_found', message: 'Diagnostic grant was not found', statusCode: 404 })
    })
  }

  async getDiagnosticForStaff(staffId: string, caseId: string, grantId: string, requestId?: string): Promise<{ id: string, scopeVersion: string, expiresAt: Date, summary: DiagnosticSummary }> {
    this.assertInternalHosted()
    await this.requireStaffPermission(staffId, 'support.diagnostics')
    const [grant] = await this.database.db.select({ id: supportDiagnosticGrants.id, scopeVersion: supportDiagnosticGrants.scopeVersion, expiresAt: supportDiagnosticGrants.expiresAt, snapshotCiphertext: supportDiagnosticGrants.snapshotCiphertext })
      .from(supportDiagnosticGrants).where(and(eq(supportDiagnosticGrants.id, grantId), eq(supportDiagnosticGrants.caseId, caseId), sql`${supportDiagnosticGrants.revokedAt} is null`, sql`${supportDiagnosticGrants.deletedAt} is null`, sql`${supportDiagnosticGrants.expiresAt} > now()`)).limit(1)
    if (grant === undefined) throw new ApiError({ code: 'diagnostic_grant_unavailable', message: 'Diagnostic grant is unavailable', statusCode: 404 })
    let summary: DiagnosticSummary
    try { summary = JSON.parse(this.decrypt(caseId, grant.snapshotCiphertext)) as DiagnosticSummary; assertDiagnosticSummary(summary) } catch { throw new ApiError({ code: 'diagnostic_snapshot_unavailable', message: 'Diagnostic snapshot is unavailable', statusCode: 409 }) }
    await this.audit?.record({ actorType: 'staff', actorId: staffId, action: 'support.diagnostic.read', targetType: 'support-diagnostic-grant', targetId: grantId, ...(requestId === undefined ? {} : { requestId }), metadata: { caseId, scopeVersion: grant.scopeVersion } })
    return { id: grant.id, scopeVersion: grant.scopeVersion, expiresAt: grant.expiresAt, summary }
  }

  /** Transport-free staff operation. The OIDC edge must first turn a verified
   * assertion into a StaffSession, then call this with that session's staff ID. */
  async listForStaff(staffId: string, requestId?: string) {
    this.assertInternalHosted()
    await this.requireStaffPermission(staffId, 'support.read')
    const rows = await this.database.db.select().from(supportCases).orderBy(desc(supportCases.updatedAt)).limit(200)
    await this.audit?.record({ actorType: 'staff', actorId: staffId, action: 'support.case.list', targetType: 'support-case-queue', ...(requestId === undefined ? {} : { requestId }), metadata: { count: rows.length } })
    return rows.map(row => ({
      id: row.id, category: row.category, severity: row.severity, status: row.status,
      subject: row.subject, assignedStaffId: row.assignedStaffId, lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    }))
  }

  async getForStaff(staffId: string, caseId: string, requestId?: string) {
    this.assertInternalHosted()
    await this.requireStaffPermission(staffId, 'support.read')
    const [caseRow] = await this.database.db.select().from(supportCases).where(eq(supportCases.id, caseId)).limit(1)
    if (caseRow === undefined) throw new ApiError({ code: 'support_case_not_found', message: 'Support case was not found', statusCode: 404 })
    const messages = await this.database.db.select().from(supportMessages).where(eq(supportMessages.caseId, caseId)).orderBy(asc(supportMessages.createdAt))
    await this.audit?.record({ actorType: 'staff', actorId: staffId, action: 'support.case.read', targetType: 'support-case', targetId: caseId, ...(requestId === undefined ? {} : { requestId }), metadata: { messageCount: messages.length } })
    return {
      id: caseRow.id, category: caseRow.category, severity: caseRow.severity, status: caseRow.status,
      subject: caseRow.subject, assignedStaffId: caseRow.assignedStaffId, lastMessageAt: caseRow.lastMessageAt,
      createdAt: caseRow.createdAt, updatedAt: caseRow.updatedAt,
      messages: messages.map(message => ({ id: message.id, authorType: message.authorType, visibility: message.visibility, body: this.decrypt(caseId, message.bodyCiphertext), createdAt: message.createdAt })),
    }
  }

  async appendStaffMessage(staffId: string, caseId: string, body: string, idempotencyKey: string, requestId?: string, visibility: 'customer' | 'internal' = 'customer'): Promise<{ id: string, created: boolean }> {
    this.assertInternalHosted()
    await this.requireStaffPermission(staffId, 'support.write')
    const plaintext = normalizeBody(body)
    const requestHash = this.requestHash(plaintext)
    const legacyRequestHash = legacyHash(plaintext)
    return await this.database.db.transaction(async (tx) => {
      const [caseRow] = await tx.select({ id: supportCases.id, status: supportCases.status }).from(supportCases)
        .where(eq(supportCases.id, caseId)).limit(1).for('update')
      if (caseRow === undefined || ['closed', 'spam'].includes(caseRow.status)) {
        throw new ApiError({ code: 'support_case_not_found', message: 'Support case was not found', statusCode: 404 })
      }
      const [existing] = await tx.select({ id: supportMessages.id, requestHash: supportMessages.requestHash }).from(supportMessages).where(and(
        eq(supportMessages.caseId, caseId), eq(supportMessages.authorType, 'staff'),
        eq(supportMessages.authorRef, staffId), eq(supportMessages.idempotencyKey, idempotencyKey),
      )).limit(1)
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash && existing.requestHash !== legacyRequestHash) {
          throw new ApiError({ code: 'idempotency_conflict', message: 'Support idempotency key was reused with different content', statusCode: 409 })
        }
        return { id: existing.id, created: false }
      }
      const now = new Date()
      const [created] = await tx.insert(supportMessages).values({
        caseId, authorType: 'staff', authorRef: staffId, visibility,
        bodyCiphertext: this.encrypt(caseId, plaintext), bodyKeyId: 'support-aead-v1', bodyEncryptionVersion: 1,
        idempotencyKey, requestHash,
      }).returning({ id: supportMessages.id })
      if (created === undefined) throw new Error('Support message insert returned no row')
      if (visibility === 'customer') {
        await tx.update(supportCases).set({ status: 'waiting_for_user', lastMessageAt: now, updatedAt: now }).where(eq(supportCases.id, caseId))
      }
      await this.audit?.recordInTransaction(tx, { actorType: 'staff', actorId: staffId, action: visibility === 'customer' ? 'support.case.reply' : 'support.case.internal_note', targetType: 'support-case', targetId: caseId, ...(requestId === undefined ? {} : { requestId }), metadata: { visibility } })
      return { id: created.id, created: true }
    })
  }

  /** Claims or releases a queue assignment. Staff may only release their own
   * assignment; reassignment belongs to the future support-admin workflow. */
  async setOwnAssignment(staffId: string, caseId: string, assigned: boolean, requestId?: string): Promise<{ assignedStaffId: string | null }> {
    this.assertInternalHosted()
    await this.requireStaffPermission(staffId, 'support.write')
    return await this.database.db.transaction(async (tx) => {
      const [caseRow] = await tx.select({ id: supportCases.id, assignedStaffId: supportCases.assignedStaffId })
        .from(supportCases).where(eq(supportCases.id, caseId)).limit(1).for('update')
      if (caseRow === undefined) throw new ApiError({ code: 'support_case_not_found', message: 'Support case was not found', statusCode: 404 })
      if (!assigned && caseRow.assignedStaffId !== null && caseRow.assignedStaffId !== staffId) {
        throw new ApiError({ code: 'support_assignment_forbidden', message: 'Only the assigned staff member may release this case', statusCode: 403 })
      }
      const assignedStaffId = assigned ? staffId : null
      await tx.update(supportCases).set({ assignedStaffId, updatedAt: new Date() }).where(eq(supportCases.id, caseId))
      await this.audit?.recordInTransaction(tx, {
        actorType: 'staff', actorId: staffId, action: assigned ? 'support.case.claim' : 'support.case.release',
        targetType: 'support-case', targetId: caseId, ...(requestId === undefined ? {} : { requestId }),
        metadata: { assignedStaffId },
      })
      return { assignedStaffId }
    })
  }

  private encrypt(caseId: string, plaintext: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key(), iv); cipher.setAAD(Buffer.from(caseId))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`
  }
  private decrypt(caseId: string, value: string): string {
    const [ivText, ciphertextText, tagText, ...extra] = value.split('.')
    if (!ivText || !ciphertextText || !tagText || extra.length !== 0) throw new Error('Support message ciphertext is malformed')
    try { const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivText, 'base64url')); decipher.setAAD(Buffer.from(caseId)); decipher.setAuthTag(Buffer.from(tagText, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8') } catch { throw new Error('Support message ciphertext cannot be decrypted') }
  }
  private key(): Buffer { return createHmac('sha256', this.config.authSecret).update('notegen-support-aead-v1').digest() }
  private subjectHash(accountId: string): string { return createHmac('sha256', this.config.authSecret).update(`support-subject:v1:${accountId}`).digest('base64url') }
  private accountLoginHash(login: string): string { return createHmac('sha256', this.config.authSecret).update(`support-account-login:v1:${login.trim().toLocaleLowerCase('und')}`).digest('base64url') }
  private requestHash(value: string): string { return createHmac('sha256', this.config.authSecret).update(`support-request:v1:${value}`).digest('base64url') }
  private assertInternalHosted(): void { if (this.config.deploymentMode !== 'hosted' || this.config.hostedReleaseStage !== 'internal-test') throw new ApiError({ code: 'support_internal_test_only', message: 'Support cases are not enabled in this deployment', statusCode: 403 }) }

  private async requireStaffPermission(staffId: string, permission: 'support.read' | 'support.write' | 'support.diagnostics'): Promise<void> {
    if (this.staff === undefined) throw new ApiError({ code: 'staff_realm_unavailable', message: 'Staff realm is unavailable', statusCode: 503 })
    await this.staff.requirePermission(staffId, permission)
  }

  /**
   * Shares the deletion subject lock with DeletionService. This closes the
   * window where an already-authenticated web request might add a support
   * message after the deletion transaction fenced the account for writes.
   */
  private async assertAccountWriteAllowed(tx: DeletionFenceTransaction, accountId: string): Promise<void> {
    await assertAccountWriteAllowedInTransaction(tx, accountId)
  }
}
function normalizeSubject(value: string): string { const result = value.trim(); if (result.length < 1 || result.length > 200) throw new ApiError({ code: 'support_subject_invalid', message: 'Support subject must contain 1 to 200 characters', statusCode: 400 }); return result }
function normalizeBody(value: string): string { const result = value.trim(); if (result.length < 1 || result.length > 10_000) throw new ApiError({ code: 'support_message_invalid', message: 'Support message must contain 1 to 10000 characters', statusCode: 400 }); return result }
function assertDiagnosticSummary(value: DiagnosticSummary): void {
  const queueKeys = ['pendingMutations', 'pendingOutbox', 'blockedOutbox', 'pendingInbox', 'failedInbox', 'unresolvedConflicts', 'pendingTransfers', 'failedTransfers'] as const
  if (value.formatVersion !== 1 || typeof value.phase !== 'string' || value.phase.length > 100 || (value.pauseReason !== null && (typeof value.pauseReason !== 'string' || value.pauseReason.length > 200)) || typeof value.server !== 'object' || typeof value.server.configured !== 'boolean' || !['hosted', 'self-hosted', null].includes(value.server.deploymentMode) || (value.server.serverVersion !== null && (typeof value.server.serverVersion !== 'string' || value.server.serverVersion.length > 100)) || typeof value.server.syncEpochKnown !== 'boolean' || typeof value.queue !== 'object' || queueKeys.some(key => !Number.isSafeInteger(value.queue[key]) || value.queue[key] < 0 || value.queue[key] > 1_000_000_000)) throw new ApiError({ code: 'diagnostic_summary_invalid', message: 'Diagnostic summary is invalid', statusCode: 400 })
}
function legacyHash(value: string): string { return createHash('sha256').update(value).digest('base64url') }
