import { and, eq, gt, isNull, or } from 'drizzle-orm'
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
}
