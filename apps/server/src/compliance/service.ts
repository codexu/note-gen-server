import { createHash, createHmac } from 'node:crypto'
import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { DatabaseContext } from '../database/client.js'
import { dataRequests, policyAcceptances, policyDocuments } from '../database/schema.js'
import { ApiError } from '../errors.js'

export type PolicyDocumentType = 'terms' | 'privacy' | 'data_processing' | 'cookie'
export type DataRequestType = 'access' | 'export' | 'correct' | 'delete' | 'restrict' | 'object'

/**
 * 05A/05B durable evidence layer. It intentionally contains no legal-policy
 * decisions: those remain versioned input documents and configured operations
 * policy, not constants hidden in the service.
 */
export class ComplianceService {
  constructor(private readonly database: DatabaseContext, private readonly config: AppConfig) {}

  subjectHash(accountId: string): string {
    return createHmac('sha256', this.config.authSecret).update(`compliance-subject:v1:${accountId}`).digest('base64url')
  }

  async listCurrentDocuments(locale: string): Promise<Array<{ id: string, type: string, version: string, contentRef: string, contentHash: string, effectiveAt: Date, requiresReacceptance: boolean }>> {
    return await this.database.db.select({
      id: policyDocuments.id, type: policyDocuments.type, version: policyDocuments.version, contentRef: policyDocuments.contentRef,
      contentHash: policyDocuments.contentHash, effectiveAt: policyDocuments.effectiveAt, requiresReacceptance: policyDocuments.requiresReacceptance,
    }).from(policyDocuments).where(and(eq(policyDocuments.locale, locale), lte(policyDocuments.effectiveAt, new Date()), isNull(policyDocuments.retiredAt)))
      .orderBy(policyDocuments.type, desc(policyDocuments.effectiveAt))
  }

  async requiredReacceptance(accountId: string): Promise<string[]> {
    const required = await this.database.db.select({ id: policyDocuments.id }).from(policyDocuments).where(and(
      eq(policyDocuments.requiresReacceptance, true), lte(policyDocuments.effectiveAt, new Date()), isNull(policyDocuments.retiredAt),
    ))
    if (required.length === 0) return []
    const ids = required.map(document => document.id)
    const accepted = await this.database.db.select({ policyDocumentId: policyAcceptances.policyDocumentId }).from(policyAcceptances)
      .where(and(eq(policyAcceptances.accountId, accountId), inArray(policyAcceptances.policyDocumentId, ids)))
    const acceptedIds = new Set(accepted.map(row => row.policyDocumentId))
    return ids.filter(id => !acceptedIds.has(id))
  }

  async publishInternalDocument(input: {
    type: PolicyDocumentType
    version: string
    locale: string
    contentRef: string
    canonicalizationVersion: number
    contentHash: string
    effectiveAt: Date
    requiresReacceptance: boolean
  }): Promise<{ id: string, created: boolean }> {
    this.assertInternalTest()
    const [existing] = await this.database.db.select({ id: policyDocuments.id, contentHash: policyDocuments.contentHash })
      .from(policyDocuments).where(and(eq(policyDocuments.type, input.type), eq(policyDocuments.version, input.version), eq(policyDocuments.locale, input.locale))).limit(1)
    if (existing !== undefined) {
      if (existing.contentHash !== input.contentHash) throw new ApiError({ code: 'policy_document_immutable', message: 'Policy version already has different content', statusCode: 409 })
      return { id: existing.id, created: false }
    }
    const [created] = await this.database.db.insert(policyDocuments).values(input).returning({ id: policyDocuments.id })
    if (created === undefined) throw new Error('Policy document insert returned no row')
    return { id: created.id, created: true }
  }

  async recordAcceptance(input: {
    accountId: string
    policyDocumentId: string
    subjectSnapshot: Record<string, unknown>
    ipPrefixHash?: string
    userAgentFamily?: string
  }): Promise<{ id: bigint }> {
    this.assertInternalTest()
    const [document] = await this.database.db.select({ id: policyDocuments.id, effectiveAt: policyDocuments.effectiveAt, retiredAt: policyDocuments.retiredAt })
      .from(policyDocuments).where(eq(policyDocuments.id, input.policyDocumentId)).limit(1)
    if (document === undefined || document.effectiveAt > new Date() || document.retiredAt !== null) {
      throw new ApiError({ code: 'policy_document_not_available', message: 'Policy document is not available for acceptance', statusCode: 409 })
    }
    const [accepted] = await this.database.db.insert(policyAcceptances).values({
      accountId: input.accountId, policyDocumentId: input.policyDocumentId, subjectHash: this.subjectHash(input.accountId),
      subjectSnapshot: minimizeSubjectSnapshot(input.subjectSnapshot), ipPrefixHash: input.ipPrefixHash, userAgentFamily: input.userAgentFamily, evidenceVersion: 1,
    }).returning({ id: policyAcceptances.id })
    if (accepted === undefined) throw new Error('Policy acceptance insert returned no row')
    return accepted
  }

  async createDataRequest(input: {
    accountId: string
    clientIdempotencyKey: string
    type: DataRequestType
    requestChannel: string
  }): Promise<{ id: string, created: boolean, status: string }> {
    this.assertInternalTest()
    const subjectHash = this.subjectHash(input.accountId)
    const requestHash = createHash('sha256').update(JSON.stringify({ type: input.type, requestChannel: input.requestChannel })).digest('base64url')
    return await this.database.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: dataRequests.id, requestHash: dataRequests.requestHash, status: dataRequests.status })
        .from(dataRequests).where(and(eq(dataRequests.subjectHash, subjectHash), eq(dataRequests.clientIdempotencyKey, input.clientIdempotencyKey))).limit(1)
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) throw new ApiError({ code: 'idempotency_conflict', message: 'Data request key was reused with different input', statusCode: 409 })
        return { id: existing.id, created: false, status: existing.status }
      }
      const [created] = await tx.insert(dataRequests).values({
        accountId: input.accountId, subjectHash, clientIdempotencyKey: input.clientIdempotencyKey, requestHash,
        type: input.type, requestChannel: input.requestChannel,
      }).returning({ id: dataRequests.id, status: dataRequests.status })
      if (created === undefined) throw new Error('Data request insert returned no row')
      return { id: created.id, created: true, status: created.status }
    })
  }

  async listDataRequests(accountId: string): Promise<Array<{ id: string, type: string, status: string, dueAt: Date | null, completedAt: Date | null, createdAt: Date }>> {
    return await this.database.db.select({
      id: dataRequests.id, type: dataRequests.type, status: dataRequests.status, dueAt: dataRequests.dueAt,
      completedAt: dataRequests.completedAt, createdAt: dataRequests.createdAt,
    }).from(dataRequests).where(eq(dataRequests.accountId, accountId)).orderBy(desc(dataRequests.createdAt))
  }

  private assertInternalTest(): void {
    if (this.config.deploymentMode !== 'hosted' || this.config.hostedReleaseStage !== 'internal-test') {
      throw new ApiError({ code: 'compliance_internal_test_only', message: 'Compliance write flows are not available in this deployment', statusCode: 403 })
    }
  }
}

function minimizeSubjectSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['accountId', 'identityState', 'countryCode']
  return Object.fromEntries(allowed.flatMap((key) => snapshot[key] === undefined ? [] : [[key, snapshot[key]]]))
}
