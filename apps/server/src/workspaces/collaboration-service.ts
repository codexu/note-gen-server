import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DatabaseContext } from '../database/client.js'
import {
  accounts, workspaceInvitations, workspaceMembers, workspaces,
} from '../database/schema.js'
import { ApiError } from '../errors.js'
import type { ChangeNotifier } from '../sync/types.js'
import {
  capabilitiesForRole, normalizeWorkspaceCapabilities, workspaceCapabilities,
  type WorkspaceCapability, type WorkspaceMemberRole,
} from './capabilities.js'
import type { WorkspaceService } from './service.js'
import type { WorkspaceAccess } from './service.js'

interface MembershipInput {
  role: WorkspaceMemberRole
  capabilities?: string[]
}

export class WorkspaceCollaborationService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly workspacesService: WorkspaceService,
    private readonly notifier: ChangeNotifier,
  ) {}

  async listMembers(accountId: string, workspaceId: string) {
    await this.workspacesService.assertCapability(accountId, workspaceId, 'content.read')
    const [workspace] = await this.database.db.select({
      ownerAccountId: workspaces.accountId,
      ownerLogin: accounts.login,
      type: workspaces.type,
    }).from(workspaces).innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt))).limit(1)
    if (workspace === undefined) throw workspaceNotFound()
    const members = await this.database.db.select({
      accountId: workspaceMembers.accountId,
      login: accounts.login,
      role: workspaceMembers.role,
      capabilities: workspaceMembers.capabilities,
      joinedAt: workspaceMembers.joinedAt,
      updatedAt: workspaceMembers.updatedAt,
    }).from(workspaceMembers).innerJoin(accounts, eq(accounts.id, workspaceMembers.accountId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(workspaceMembers.joinedAt)
    return [{
      accountId: workspace.ownerAccountId,
      login: workspace.ownerLogin,
      role: 'owner' as const,
      capabilities: [...workspaceCapabilities],
      joinedAt: null,
      updatedAt: null,
    }, ...members.map(member => ({
      ...member,
      capabilities: normalizeWorkspaceCapabilities(member.capabilities),
    }))]
  }

  async listInvitations(accountId: string, workspaceId: string) {
    await this.#assertShareable(accountId, workspaceId, 'member.invite')
    const rows = await this.database.db.select().from(workspaceInvitations).where(and(
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.status, 'pending'),
    )).orderBy(workspaceInvitations.createdAt)
    return rows.map(serializeInvitation)
  }

  async listPendingForAccount(accountId: string) {
    const rows = await this.database.db.select({
      invitation: workspaceInvitations,
      workspaceNameCiphertext: workspaces.nameCiphertext,
      inviterLogin: accounts.login,
    }).from(workspaceInvitations)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
      .innerJoin(accounts, eq(accounts.id, workspaceInvitations.invitedByAccountId))
      .where(and(
        eq(workspaceInvitations.kind, 'account'),
        eq(workspaceInvitations.inviteeAccountId, accountId),
        eq(workspaceInvitations.status, 'pending'),
        isNull(workspaces.deletedAt),
      )).orderBy(workspaceInvitations.createdAt)
    return rows.map(row => ({
      ...serializeInvitation(row.invitation),
      workspaceNameCiphertext: row.workspaceNameCiphertext,
      inviterLogin: row.inviterLogin,
    }))
  }

  async inviteAccount(
    actorAccountId: string,
    workspaceId: string,
    login: string,
    input: MembershipInput,
    expiresInSeconds = 7 * 24 * 60 * 60,
  ) {
    const actor = await this.#assertShareable(actorAccountId, workspaceId, 'member.invite')
    const normalizedLogin = login.trim().toLocaleLowerCase('en-US')
    const [invitee] = await this.database.db.select({ id: accounts.id, login: accounts.login })
      .from(accounts).where(and(
        sql`lower(${accounts.login}) = ${normalizedLogin}`,
        isNull(accounts.disabledAt),
        isNull(accounts.suspendedAt),
      )).limit(1)
    if (invitee === undefined) {
      throw new ApiError({ code: 'invitee_not_found', message: 'Invitee account was not found', statusCode: 404 })
    }
    const [workspace] = await this.database.db.select({ ownerAccountId: workspaces.accountId })
      .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (workspace?.ownerAccountId === invitee.id) {
      throw new ApiError({ code: 'workspace_owner_already_member', message: 'Workspace owner is already a member', statusCode: 409 })
    }
    const capabilities = membershipCapabilities(input)
    assertGrantable(actor, capabilities)
    const [invitation] = await this.database.db.insert(workspaceInvitations).values({
      workspaceId,
      kind: 'account',
      inviteeAccountId: invitee.id,
      role: input.role,
      capabilities,
      invitedByAccountId: actorAccountId,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
    }).onConflictDoUpdate({
      target: [workspaceInvitations.workspaceId, workspaceInvitations.inviteeAccountId],
      targetWhere: sql`${workspaceInvitations.kind} = 'account' and ${workspaceInvitations.status} = 'pending'`,
      set: {
        role: input.role,
        capabilities,
        invitedByAccountId: actorAccountId,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
        updatedAt: new Date(),
      },
    }).returning()
    if (invitation === undefined) throw new Error('Workspace invitation insert returned no row')
    await this.#publishMembershipChanged(workspaceId, invitee.id)
    return { ...serializeInvitation(invitation), inviteeLogin: invitee.login }
  }

  async createLink(
    actorAccountId: string,
    workspaceId: string,
    input: MembershipInput,
    expiresInSeconds = 7 * 24 * 60 * 60,
  ) {
    const actor = await this.#assertShareable(actorAccountId, workspaceId, 'member.invite')
    const capabilities = membershipCapabilities(input)
    assertGrantable(actor, capabilities)
    const token = randomBytes(32).toString('base64url')
    const [invitation] = await this.database.db.insert(workspaceInvitations).values({
      workspaceId,
      kind: 'link',
      tokenHash: tokenDigest(token),
      tokenHint: token.slice(-6),
      role: input.role,
      capabilities,
      invitedByAccountId: actorAccountId,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
    }).returning()
    if (invitation === undefined) throw new Error('Workspace invitation insert returned no row')
    return { ...serializeInvitation(invitation), token }
  }

  async acceptAccountInvitation(accountId: string, invitationId: string) {
    return this.#accept(accountId, and(
      eq(workspaceInvitations.id, invitationId),
      eq(workspaceInvitations.kind, 'account'),
      eq(workspaceInvitations.inviteeAccountId, accountId),
    ))
  }

  async acceptLink(accountId: string, token: string) {
    return this.#accept(accountId, and(
      eq(workspaceInvitations.tokenHash, tokenDigest(token)),
      eq(workspaceInvitations.kind, 'link'),
    ))
  }

  async updateMember(
    actorAccountId: string,
    workspaceId: string,
    memberAccountId: string,
    input: MembershipInput,
  ) {
    const actor = await this.#assertShareable(actorAccountId, workspaceId, 'member.update')
    const capabilities = membershipCapabilities(input)
    assertGrantable(actor, capabilities)
    const [member] = await this.database.db.update(workspaceMembers).set({
      role: input.role,
      capabilities,
      updatedAt: new Date(),
    }).where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.accountId, memberAccountId),
    )).returning()
    if (member === undefined) throw memberNotFound()
    const [account] = await this.database.db.select({ login: accounts.login })
      .from(accounts).where(eq(accounts.id, memberAccountId)).limit(1)
    if (account === undefined) throw memberNotFound()
    await this.#publishMembershipChanged(workspaceId, memberAccountId)
    return {
      accountId: member.accountId,
      login: account.login,
      role: member.role,
      capabilities: normalizeWorkspaceCapabilities(member.capabilities),
      joinedAt: member.joinedAt,
      updatedAt: member.updatedAt,
    }
  }

  async removeMember(actorAccountId: string, workspaceId: string, memberAccountId: string): Promise<void> {
    await this.#assertShareable(actorAccountId, workspaceId, 'member.remove')
    const removed = await this.database.db.delete(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.accountId, memberAccountId),
    )).returning({ accountId: workspaceMembers.accountId })
    if (removed.length === 0) throw memberNotFound()
    await this.#publishMembershipChanged(workspaceId, memberAccountId)
  }

  async revokeInvitation(actorAccountId: string, workspaceId: string, invitationId: string): Promise<void> {
    await this.#assertShareable(actorAccountId, workspaceId, 'member.invite')
    const [revoked] = await this.database.db.update(workspaceInvitations).set({
      status: 'revoked', revokedAt: new Date(), updatedAt: new Date(),
    }).where(and(
      eq(workspaceInvitations.id, invitationId),
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.status, 'pending'),
    )).returning({ id: workspaceInvitations.id })
    if (revoked === undefined) {
      throw new ApiError({ code: 'workspace_invitation_not_found', message: 'Pending invitation was not found', statusCode: 404 })
    }
    await this.notifier.publish({ type: 'workspace.members-changed', workspaceId }).catch(() => undefined)
  }

  async #accept(accountId: string, predicate: ReturnType<typeof and>) {
    const accepted = await this.database.db.transaction(async tx => {
      const [invitation] = await tx.select().from(workspaceInvitations)
        .where(and(predicate, eq(workspaceInvitations.status, 'pending'))).limit(1).for('update')
      if (invitation === undefined) {
        throw new ApiError({ code: 'workspace_invitation_not_found', message: 'Pending invitation was not found', statusCode: 404 })
      }
      if (invitation.expiresAt <= new Date()) {
        await tx.update(workspaceInvitations).set({ status: 'expired', updatedAt: new Date() })
          .where(eq(workspaceInvitations.id, invitation.id))
        return { expired: true as const, workspaceId: invitation.workspaceId }
      }
      const [workspace] = await tx.select({ ownerAccountId: workspaces.accountId, type: workspaces.type })
        .from(workspaces).where(and(eq(workspaces.id, invitation.workspaceId), isNull(workspaces.deletedAt))).limit(1)
      if (workspace === undefined) throw workspaceNotFound()
      if (workspace.type !== 'library') throw accountDataCannotBeShared()
      if (workspace.ownerAccountId === accountId) {
        throw new ApiError({ code: 'workspace_owner_already_member', message: 'Workspace owner is already a member', statusCode: 409 })
      }
      await tx.insert(workspaceMembers).values({
        workspaceId: invitation.workspaceId,
        accountId,
        role: invitation.role,
        capabilities: invitation.capabilities,
        invitedByAccountId: invitation.invitedByAccountId,
      }).onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.accountId],
        set: {
          role: invitation.role,
          capabilities: invitation.capabilities,
          invitedByAccountId: invitation.invitedByAccountId,
          updatedAt: new Date(),
        },
      })
      await tx.update(workspaceInvitations).set({
        status: 'accepted', acceptedByAccountId: accountId,
        acceptedAt: new Date(), updatedAt: new Date(),
      }).where(eq(workspaceInvitations.id, invitation.id))
      return { expired: false as const, workspaceId: invitation.workspaceId }
    })
    if (accepted.expired) {
      throw new ApiError({ code: 'workspace_invitation_expired', message: 'Invitation has expired', statusCode: 410 })
    }
    await this.#publishMembershipChanged(accepted.workspaceId, accountId)
    return { workspaceId: accepted.workspaceId }
  }

  async #assertShareable(
    accountId: string,
    workspaceId: string,
    capability: 'member.invite' | 'member.update' | 'member.remove',
  ): Promise<WorkspaceAccess> {
    const access = await this.workspacesService.assertCapability(accountId, workspaceId, capability)
    if (access.type !== 'library') throw accountDataCannotBeShared()
    return access
  }

  async #publishMembershipChanged(workspaceId: string, accountId: string): Promise<void> {
    await Promise.all([
      this.notifier.publish({ type: 'workspace.members-changed', workspaceId }).catch(() => undefined),
      this.notifier.publish({ type: 'account.workspaces-changed', accountId }).catch(() => undefined),
    ])
  }
}

function membershipCapabilities(input: MembershipInput): WorkspaceCapability[] {
  try {
    return normalizeWorkspaceCapabilities(input.capabilities ?? capabilitiesForRole(input.role))
  } catch {
    throw new ApiError({ code: 'workspace_capability_invalid', message: 'Workspace capability list is invalid', statusCode: 400 })
  }
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function serializeInvitation(invitation: typeof workspaceInvitations.$inferSelect) {
  const { tokenHash: _tokenHash, ...safe } = invitation
  return { ...safe, capabilities: normalizeWorkspaceCapabilities(safe.capabilities) }
}

function workspaceNotFound(): ApiError {
  return new ApiError({ code: 'workspace_not_found', message: 'Workspace not found', statusCode: 404 })
}

function memberNotFound(): ApiError {
  return new ApiError({ code: 'workspace_member_not_found', message: 'Workspace member was not found', statusCode: 404 })
}

function accountDataCannotBeShared(): ApiError {
  return new ApiError({
    code: 'account_data_workspace_not_shareable',
    message: 'Personal account-data workspaces cannot be shared',
    statusCode: 409,
  })
}

function assertGrantable(actor: WorkspaceAccess, capabilities: readonly WorkspaceCapability[]): void {
  if (actor.owner || capabilities.every(capability => actor.capabilities.includes(capability))) return
  throw new ApiError({
    code: 'workspace_capability_escalation_denied',
    message: 'Members cannot grant capabilities they do not hold',
    statusCode: 403,
  })
}
