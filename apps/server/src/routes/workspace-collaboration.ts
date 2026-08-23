import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AuthService } from '../auth/service.js'
import { requireAuth } from '../auth/http-auth.js'
import type { TokenService } from '../auth/tokens.js'
import type { WorkspaceCollaborationService } from '../workspaces/collaboration-service.js'
import { workspaceCapabilities } from '../workspaces/capabilities.js'

const WorkspaceParams = Type.Object({ workspaceId: Type.String({ format: 'uuid' }) })
const MemberParams = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  accountId: Type.String({ format: 'uuid' }),
})
const InvitationParams = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
  invitationId: Type.String({ format: 'uuid' }),
})
const Role = Type.Union([Type.Literal('viewer'), Type.Literal('editor'), Type.Literal('manager')])
const Capability = Type.Union(workspaceCapabilities.map(capability => Type.Literal(capability)))
const Membership = Type.Object({
  role: Role,
  capabilities: Type.Optional(Type.Array(Capability, { uniqueItems: true, maxItems: workspaceCapabilities.length })),
})
const NullableTimestamp = Type.Union([Type.String({ format: 'date-time' }), Type.Null()])
const MemberResponse = Type.Object({
  accountId: Type.String({ format: 'uuid' }),
  login: Type.String(),
  role: Type.Union([Type.Literal('owner'), Role]),
  capabilities: Type.Array(Capability),
  joinedAt: NullableTimestamp,
  updatedAt: NullableTimestamp,
})
const InvitationResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  workspaceId: Type.String({ format: 'uuid' }),
  kind: Type.Union([Type.Literal('account'), Type.Literal('link')]),
  inviteeAccountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  tokenHint: Type.Union([Type.String(), Type.Null()]),
  role: Role,
  capabilities: Type.Array(Capability),
  status: Type.Union([
    Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('revoked'), Type.Literal('expired'),
  ]),
  invitedByAccountId: Type.String({ format: 'uuid' }),
  acceptedByAccountId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  expiresAt: Type.String({ format: 'date-time' }),
  acceptedAt: NullableTimestamp,
  revokedAt: NullableTimestamp,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
})

export function createWorkspaceCollaborationRoutes(
  collaboration: WorkspaceCollaborationService,
  tokens: TokenService,
  auth: AuthService,
): FastifyPluginAsyncTypebox {
  return async function workspaceCollaborationRoutes(app) {
    app.get('/v1/workspaces/:workspaceId/members', {
      schema: { params: WorkspaceParams, response: { 200: Type.Array(MemberResponse) } },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return collaboration.listMembers(claims.accountId, request.params.workspaceId)
    })

    app.get('/v1/workspaces/:workspaceId/invitations', {
      schema: { params: WorkspaceParams, response: { 200: Type.Array(InvitationResponse) } },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return collaboration.listInvitations(claims.accountId, request.params.workspaceId)
    })

    app.get('/v1/workspace-invitations', {
      schema: {
        response: { 200: Type.Array(Type.Intersect([InvitationResponse, Type.Object({
          workspaceNameCiphertext: Type.String(),
          inviterLogin: Type.String(),
        })])) },
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return collaboration.listPendingForAccount(claims.accountId)
    })

    app.post('/v1/workspaces/:workspaceId/invitations/account', {
      schema: {
        params: WorkspaceParams,
        body: Type.Intersect([Membership, Type.Object({
          login: Type.String({ minLength: 1, maxLength: 320 }),
          expiresInSeconds: Type.Optional(Type.Integer({ minimum: 300, maximum: 30 * 24 * 60 * 60 })),
        })]),
        response: { 201: Type.Intersect([InvitationResponse, Type.Object({ inviteeLogin: Type.String() })]) },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      const result = await collaboration.inviteAccount(
        claims.accountId, request.params.workspaceId, request.body.login,
        request.body, request.body.expiresInSeconds,
      )
      return reply.status(201).send(result)
    })

    app.post('/v1/workspaces/:workspaceId/invitations/link', {
      schema: {
        params: WorkspaceParams,
        body: Type.Intersect([Membership, Type.Object({
          expiresInSeconds: Type.Optional(Type.Integer({ minimum: 300, maximum: 30 * 24 * 60 * 60 })),
        })]),
        response: { 201: Type.Intersect([InvitationResponse, Type.Object({ token: Type.String() })]) },
      },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      const result = await collaboration.createLink(
        claims.accountId, request.params.workspaceId, request.body, request.body.expiresInSeconds,
      )
      return reply.status(201).send(result)
    })

    app.post('/v1/workspace-invitations/:invitationId/accept', {
      schema: {
        params: Type.Object({ invitationId: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }) },
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return collaboration.acceptAccountInvitation(claims.accountId, request.params.invitationId)
    })

    app.post('/v1/workspace-invitations/accept-link', {
      schema: {
        body: Type.Object({ token: Type.String({ minLength: 32, maxLength: 128 }) }),
        response: { 200: Type.Object({ workspaceId: Type.String({ format: 'uuid' }) }) },
      },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return collaboration.acceptLink(claims.accountId, request.body.token)
    })

    app.patch('/v1/workspaces/:workspaceId/members/:accountId', {
      schema: { params: MemberParams, body: Membership, response: { 200: MemberResponse } },
    }, async request => {
      const claims = await requireAuth(request, tokens, auth)
      return collaboration.updateMember(
        claims.accountId, request.params.workspaceId, request.params.accountId, request.body,
      )
    })

    app.delete('/v1/workspaces/:workspaceId/members/:accountId', {
      schema: { params: MemberParams, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await collaboration.removeMember(claims.accountId, request.params.workspaceId, request.params.accountId)
      return reply.status(204).send(null)
    })

    app.delete('/v1/workspaces/:workspaceId/invitations/:invitationId', {
      schema: { params: InvitationParams, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      const claims = await requireAuth(request, tokens, auth)
      await collaboration.revokeInvitation(claims.accountId, request.params.workspaceId, request.params.invitationId)
      return reply.status(204).send(null)
    })
  }
}
