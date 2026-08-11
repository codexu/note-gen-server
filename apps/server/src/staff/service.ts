import { and, eq, gt, isNull, or } from 'drizzle-orm'
import argon2 from 'argon2'
import type { DatabaseContext } from '../database/client.js'
import { staffPrincipals, staffRoleAssignments } from '../database/schema.js'
import { ApiError } from '../errors.js'
import { permissionsForStaffRoles, staffPermissions, staffRoleTemplates, type StaffPermission, type StaffRoleKey } from './permissions.js'

const ISSUER = /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/
const SUBJECT = /^[^\s]{1,512}$/

/**
 * Durable, provider-neutral staff identity and authorization facts. OIDC
 * verification/session cookies intentionally live at the staff edge; this
 * service only accepts an already verified issuer+subject pair.
 */
export class StaffService {
  constructor(private readonly database: DatabaseContext) {}

  async upsertFederatedPrincipal(input: {
    issuer: string
    subject: string
    displayName: string
    email?: string
  }): Promise<{ id: string, disabled: boolean }> {
    const issuer = input.issuer.trim()
    const subject = input.subject.trim()
    const displayName = input.displayName.trim()
    const email = input.email?.trim().toLocaleLowerCase('und') || null
    if (!ISSUER.test(issuer) || !SUBJECT.test(subject) || displayName.length < 1 || displayName.length > 200
      || (email !== null && (email.length > 320 || !email.includes('@')))) {
      throw new ApiError({ code: 'staff_principal_invalid', message: 'Staff principal is invalid', statusCode: 400 })
    }
    const [principal] = await this.database.db.insert(staffPrincipals).values({
      externalIssuer: issuer, externalSubject: subject, displayName, email,
    }).onConflictDoUpdate({
      target: [staffPrincipals.externalIssuer, staffPrincipals.externalSubject],
      set: { displayName, email, lastLoginAt: new Date(), updatedAt: new Date() },
    }).returning({ id: staffPrincipals.id, disabledAt: staffPrincipals.disabledAt })
    if (principal === undefined) throw new Error('Staff principal upsert returned no row')
    return { id: principal.id, disabled: principal.disabledAt !== null }
  }

  async authenticateLocal(login: string, password: string): Promise<{ id: string, login: string, displayName: string }> {
    const normalizedLogin = normalizeLocalStaffLogin(login)
    if (normalizedLogin.length < 1 || normalizedLogin.length > 200) {
      throw new ApiError({ code: 'staff_credentials_invalid', message: 'Staff credentials are invalid', statusCode: 401 })
    }
    const [principal] = await this.database.db.select({
      id: staffPrincipals.id,
      login: staffPrincipals.localLogin,
      displayName: staffPrincipals.displayName,
      passwordHash: staffPrincipals.localPasswordHash,
      disabledAt: staffPrincipals.disabledAt,
    }).from(staffPrincipals).where(eq(staffPrincipals.localLogin, normalizedLogin)).limit(1)
    const passwordMatches = principal?.passwordHash === null || principal?.passwordHash === undefined
      ? false
      : await argon2.verify(principal.passwordHash, password).catch(() => false)
    if (principal === undefined || principal.login === null || principal.disabledAt !== null || !passwordMatches) {
      throw new ApiError({ code: 'staff_credentials_invalid', message: 'Staff credentials are invalid', statusCode: 401 })
    }
    await this.database.db.update(staffPrincipals).set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(staffPrincipals.id, principal.id))
    return { id: principal.id, login: principal.login, displayName: principal.displayName }
  }

  async profile(staffId: string): Promise<{ id: string, login: string, displayName: string, roles: string[], permissions: StaffPermission[] }> {
    const [principal] = await this.database.db.select({
      id: staffPrincipals.id,
      login: staffPrincipals.localLogin,
      displayName: staffPrincipals.displayName,
      disabledAt: staffPrincipals.disabledAt,
    }).from(staffPrincipals).where(eq(staffPrincipals.id, staffId)).limit(1)
    if (principal === undefined || principal.disabledAt !== null) {
      throw new ApiError({ code: 'staff_principal_unavailable', message: 'Staff principal is unavailable', statusCode: 401 })
    }
    const assignments = await this.database.db.select({ roleKey: staffRoleAssignments.roleKey })
      .from(staffRoleAssignments).where(and(
        eq(staffRoleAssignments.staffId, staffId),
        isNull(staffRoleAssignments.revokedAt),
        or(isNull(staffRoleAssignments.expiresAt), gt(staffRoleAssignments.expiresAt, new Date())),
      ))
    const roles = assignments.map((assignment) => assignment.roleKey)
    return {
      id: principal.id,
      login: principal.login ?? principal.displayName,
      displayName: principal.displayName,
      roles,
      permissions: [...permissionsForStaffRoles(roles)],
    }
  }

  async grantRole(input: { staffId: string, roleKey: StaffRoleKey, scope?: Record<string, unknown>, expiresAt?: Date, assignedByStaffId?: string }): Promise<string> {
    if (staffRoleTemplates[input.roleKey] === undefined || (input.expiresAt !== undefined && input.expiresAt <= new Date())) {
      throw new ApiError({ code: 'staff_role_invalid', message: 'Staff role assignment is invalid', statusCode: 400 })
    }
    const [principal] = await this.database.db.select({ id: staffPrincipals.id, disabledAt: staffPrincipals.disabledAt })
      .from(staffPrincipals).where(eq(staffPrincipals.id, input.staffId)).limit(1)
    if (principal === undefined || principal.disabledAt !== null) {
      throw new ApiError({ code: 'staff_principal_unavailable', message: 'Staff principal is unavailable', statusCode: 409 })
    }
    const [assignment] = await this.database.db.insert(staffRoleAssignments).values({
      staffId: input.staffId, roleKey: input.roleKey, scope: input.scope ?? {},
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.assignedByStaffId === undefined ? {} : { assignedByStaffId: input.assignedByStaffId }),
    }).returning({ id: staffRoleAssignments.id })
    if (assignment === undefined) throw new Error('Staff role assignment insert returned no row')
    return assignment.id
  }

  async revokeRole(assignmentId: string): Promise<void> {
    // Role records are authorization facts with immutable assignment history;
    // revocation is a separate timestamp rather than deleting the assignment.
    await this.database.db.update(staffRoleAssignments).set({ revokedAt: new Date() })
      .where(and(eq(staffRoleAssignments.id, assignmentId), isNull(staffRoleAssignments.revokedAt)))
  }

  async permissionsFor(staffId: string): Promise<Set<StaffPermission>> {
    const [principal] = await this.database.db.select({ id: staffPrincipals.id, disabledAt: staffPrincipals.disabledAt })
      .from(staffPrincipals).where(eq(staffPrincipals.id, staffId)).limit(1)
    if (principal === undefined || principal.disabledAt !== null) return new Set()
    const roles = await this.database.db.select({ roleKey: staffRoleAssignments.roleKey }).from(staffRoleAssignments).where(and(
      eq(staffRoleAssignments.staffId, staffId),
      isNull(staffRoleAssignments.revokedAt),
      or(isNull(staffRoleAssignments.expiresAt), gt(staffRoleAssignments.expiresAt, new Date())),
    ))
    return permissionsForStaffRoles(roles.map(role => role.roleKey))
  }

  async requirePermission(staffId: string, permission: StaffPermission): Promise<void> {
    if (!staffPermissions.includes(permission)) throw new ApiError({ code: 'staff_permission_unknown', message: 'Staff permission is unknown', statusCode: 400 })
    if (!(await this.permissionsFor(staffId)).has(permission)) {
      throw new ApiError({ code: 'staff_permission_denied', message: 'Staff permission is required', statusCode: 403 })
    }
  }

  async getOperationsOverview(staffId: string) {
    await this.requirePermission(staffId, 'platform.provision')
    const [row] = await this.database.sql<Array<{
      account_count: number
      active_account_count: number
      new_account_count: number
      active_subscription_count: number
      open_support_case_count: number
      urgent_support_case_count: number
      review_risk_event_count: number
      pending_data_request_count: number
      active_staff_session_count: number
    }>>`
      select
        (select count(*)::int from accounts) as account_count,
        (select count(*)::int from accounts where suspended_at is null and disabled_at is null) as active_account_count,
        (select count(*)::int from accounts where created_at >= now() - interval '7 days') as new_account_count,
        (select count(*)::int from account_subscriptions where is_current = true and status in ('trialing', 'active', 'grace')) as active_subscription_count,
        (select count(*)::int from support_cases where status in ('open', 'waiting_for_support')) as open_support_case_count,
        (select count(*)::int from support_cases where severity = 'urgent' and status not in ('resolved', 'closed', 'spam')) as urgent_support_case_count,
        (select count(*)::int from risk_events where created_at >= now() - interval '24 hours' and outcome in ('review', 'deny', 'challenge')) as review_risk_event_count,
        (select count(*)::int from data_requests where status in ('submitted', 'identity_check', 'queued', 'processing', 'awaiting_user', 'held')) as pending_data_request_count,
        (select count(*)::int from staff_sessions where revoked_at is null and expires_at > now()) as active_staff_session_count
    `
    return {
      accountCount: row?.account_count ?? 0,
      activeAccountCount: row?.active_account_count ?? 0,
      newAccountCount: row?.new_account_count ?? 0,
      activeSubscriptionCount: row?.active_subscription_count ?? 0,
      openSupportCaseCount: row?.open_support_case_count ?? 0,
      urgentSupportCaseCount: row?.urgent_support_case_count ?? 0,
      reviewRiskEventCount: row?.review_risk_event_count ?? 0,
      pendingDataRequestCount: row?.pending_data_request_count ?? 0,
      activeStaffSessionCount: row?.active_staff_session_count ?? 0,
      generatedAt: new Date(),
    }
  }

  async listOperationsAccounts(staffId: string, input: {
    query: string
    status: 'all' | 'active' | 'suspended' | 'disabled'
    limit: number
  }) {
    await this.requirePermission(staffId, 'platform.provision')
    const query = input.query.trim()
    const rows = await this.database.sql<Array<{
      id: string
      login: string
      identity_state: string
      suspended_at: Date | null
      disabled_at: Date | null
      created_at: Date
      workspace_count: number
      device_count: number
      subscription_status: string | null
    }>>`
      select a.id, a.login, a.identity_state, a.suspended_at, a.disabled_at, a.created_at,
        (select count(*)::int from workspaces w where w.account_id = a.id and w.deleted_at is null) as workspace_count,
        (select count(*)::int from devices d where d.account_id = a.id and d.revoked_at is null) as device_count,
        (select s.status::text from account_subscriptions s where s.account_id = a.id and s.is_current = true limit 1) as subscription_status
      from accounts a
      where (${query} = '' or a.login ilike ('%' || ${query} || '%'))
        and (${input.status} = 'all'
          or (${input.status} = 'active' and a.suspended_at is null and a.disabled_at is null)
          or (${input.status} = 'suspended' and a.suspended_at is not null)
          or (${input.status} = 'disabled' and a.disabled_at is not null))
      order by a.created_at desc, a.id desc
      limit ${input.limit}
    `
    return rows.map(row => ({
      id: row.id,
      login: row.login,
      identityState: row.identity_state,
      status: row.disabled_at !== null ? 'disabled' : row.suspended_at !== null ? 'suspended' : 'active',
      workspaceCount: row.workspace_count,
      deviceCount: row.device_count,
      subscriptionStatus: row.subscription_status,
      createdAt: row.created_at,
    }))
  }

  async listOperationsRiskEvents(staffId: string, limit: number) {
    await this.requirePermission(staffId, 'risk.read')
    const rows = await this.database.sql<Array<{
      id: string
      event_type: string
      account_id: string | null
      account_login: string | null
      outcome: string
      reason_codes: string[]
      score: number | null
      created_at: Date
    }>>`
      select r.id::text, r.event_type, r.account_id, a.login as account_login,
        r.outcome, r.reason_codes, r.score, r.created_at
      from risk_events r
      left join accounts a on a.id = r.account_id
      order by r.created_at desc
      limit ${limit}
    `
    return rows.map(row => ({
      id: row.id,
      eventType: row.event_type,
      accountId: row.account_id,
      accountLogin: row.account_login,
      outcome: row.outcome,
      reasonCodes: row.reason_codes,
      score: row.score,
      createdAt: row.created_at,
    }))
  }

  async listOperationsSubscriptions(staffId: string, limit: number) {
    await this.requirePermission(staffId, 'billing.read')
    const rows = await this.database.sql<Array<{
      id: string
      account_id: string | null
      account_login: string | null
      provider: string
      status: string
      is_current: boolean
      current_period_end: Date | null
      created_at: Date
    }>>`
      select s.id, s.account_id, a.login as account_login, s.provider, s.status::text,
        s.is_current, s.current_period_end, s.created_at
      from account_subscriptions s
      left join accounts a on a.id = s.account_id
      order by s.updated_at desc
      limit ${limit}
    `
    return rows.map(row => ({
      id: row.id,
      accountId: row.account_id,
      accountLogin: row.account_login,
      provider: row.provider,
      status: row.status,
      isCurrent: row.is_current,
      currentPeriodEnd: row.current_period_end,
      createdAt: row.created_at,
    }))
  }

  async listOperationsDataRequests(staffId: string, limit: number) {
    await this.requirePermission(staffId, 'compliance.request.process')
    const rows = await this.database.sql<Array<{
      id: string
      account_id: string | null
      account_login: string | null
      type: string
      status: string
      request_channel: string
      due_at: Date | null
      created_at: Date
    }>>`
      select r.id, r.account_id, a.login as account_login, r.type::text, r.status::text,
        r.request_channel, r.due_at, r.created_at
      from data_requests r
      left join accounts a on a.id = r.account_id
      order by r.updated_at desc
      limit ${limit}
    `
    return rows.map(row => ({
      id: row.id,
      accountId: row.account_id,
      accountLogin: row.account_login,
      type: row.type,
      status: row.status,
      requestChannel: row.request_channel,
      dueAt: row.due_at,
      createdAt: row.created_at,
    }))
  }
}

export function normalizeLocalStaffLogin(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('und')
}
