import { type } from 'arktype';
import {
  createOrRefreshProjectInvitation,
  getPendingProjectInvitationsByUserId,
  getProjectInvitations,
  getProjectMembers,
  getProjectsByIds,
  getUser,
  getUsersByIds,
  ProjectTeamMutationError,
  removeProjectMember,
  resendProjectInvitation,
  respondToProjectInvitation,
  revokeProjectInvitation,
  setProjectMemberRole,
} from '../../db.ts';
import { sendProjectInvitationEmail } from '../../email.ts';
import type { ApiEnv } from '../../env.ts';
import { cancelContainerBuildDos } from '../../github/cancel-builds.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../../project-access.ts';
import { proxyTokenRotationWarnings } from '../../proxy-token-rotation.ts';
import { dayBucket, minuteBucket, parseCounter } from '../../routes/email.ts';
import type {
  ProjectInvitation,
  ProjectInvitationStatus,
  ProjectMember,
  ProjectRole,
  User,
} from '../../types.ts';
import { canOnProject, grantedAccess } from '../access.ts';
import { member as signedInMember, procedure } from '../procedure.ts';

const INVITATION_EMAILS_PER_MINUTE = 5;
const INVITATION_EMAILS_PER_DAY = 50;

/** One code per team mutation failure, with the actionable message the CLI prints. */
const ERRORS = {
  PROJECT_NOT_FOUND: {
    status: 404,
    message: PROJECT_PERMISSION_MESSAGES['not-found'],
  },
  PROJECT_DELETING: {
    status: 409,
    message:
      'This project is being deleted. Wait for deletion to finish and select another project.',
  },
  TARGET_USER_NOT_FOUND: {
    status: 404,
    message:
      'No eligible registered account matches that email. Check the address and ask the person to sign in to this platform before inviting them.',
  },
  OWNER_CONFLICT: {
    status: 409,
    message:
      'The project owner already has full access and cannot be managed as a team member. Manage other members instead.',
  },
  MEMBER_CONFLICT: {
    status: 409,
    message:
      'This account is already a project member. Refresh the member list to review its access.',
  },
  MEMBER_NOT_FOUND: {
    status: 404,
    message:
      'This project member could not be found. Refresh the member list and send a new invitation if access is still needed.',
  },
  INVITATION_NOT_FOUND: {
    status: 404,
    message:
      'This invitation could not be found. Check your pending invitations or ask a project admin or owner to send a new one.',
  },
  INVITATION_NOT_PENDING: {
    status: 409,
    message:
      'This invitation is no longer pending. If you still need access, ask a project admin or owner to send a new invitation.',
  },
  INVITATION_NOT_TARGET: {
    status: 403,
    message:
      'This invitation belongs to a different account. Sign in with the account that received it, or ask a project admin or owner to invite your current account.',
  },
  INVITATION_EXPIRED: {
    status: 409,
    message:
      'This invitation has expired. Ask a project admin or owner to resend it, then accept the renewed invitation.',
  },
  PENDING_INVITATION_LIMIT: {
    status: 409,
    message:
      'This project has reached its pending invitation limit. Revoke unused invitations or wait for them to expire, then try again.',
  },
  OWNER_SUSPENDED: { status: 403, message: PROJECT_PERMISSION_MESSAGES['owner-suspended'] },
  MEMBERSHIP_FORBIDDEN: { status: 403, message: PROJECT_PERMISSION_MESSAGES.members },
  INVALID_EMAIL: { status: 400, message: 'a valid registered email is required' },
  OWNER_CANNOT_LEAVE: {
    status: 409,
    message:
      'The project owner cannot leave. Ask a platform administrator to transfer ownership before leaving the project.',
  },
} as const;

type ErrorCode = keyof typeof ERRORS;

/** The procedure error code for a failed team mutation, or rethrows what is not one. */
function mutationCode(error: unknown): ErrorCode {
  if (!(error instanceof ProjectTeamMutationError)) {
    throw error;
  }
  const code =
    error.reason === 'forbidden'
      ? 'MEMBERSHIP_FORBIDDEN'
      : error.reason.toUpperCase().replaceAll('-', '_');
  if (!isErrorCode(code)) {
    throw error;
  }
  return code;
}

function isErrorCode(code: string): code is ErrorCode {
  return code in ERRORS;
}

const role = type("'reader' | 'collaborator' | 'admin'");
const userSummary = type({ id: 'string', login: 'string' });
const memberView = type({ user: userSummary, role: 'string', created_at: 'string' });
const invitationView = type({
  id: 'string',
  target: { id: 'string', login: 'string', email: 'string | null' },
  target_email: 'string',
  role: 'string',
  status: 'string',
  created_at: 'string',
  expires_at: 'string',
  accepted_at: 'string | null',
  revoked_at: 'string | null',
});
const delivery = type({ status: "'sent' | 'not_configured' | 'rate_limited' | 'failed'" });

function summary(user: User) {
  return { id: user.id, login: user.login };
}

interface MembersResult {
  members: Array<{ user: ReturnType<typeof summary>; role: ProjectRole; created_at: string }>;
  warnings?: Array<string>;
}

function memberJson(member: ProjectMember, user: User) {
  return { user: summary(user), role: member.role, created_at: member.created_at };
}

function effectiveInvitationStatus(invitation: ProjectInvitation): ProjectInvitationStatus {
  return invitation.status === 'pending' && Date.parse(invitation.expires_at) <= Date.now()
    ? 'expired'
    : invitation.status;
}

function invitationJson(invitation: ProjectInvitation, target: User) {
  return {
    id: invitation.id,
    target: { ...summary(target), email: target.email },
    target_email: invitation.target_email_snapshot,
    role: invitation.role,
    status: effectiveInvitationStatus(invitation),
    created_at: invitation.created_at,
    expires_at: invitation.expires_at,
    accepted_at: invitation.accepted_at,
    revoked_at: invitation.revoked_at,
  };
}

export async function deliverInvitation(
  env: ApiEnv['Bindings'],
  inviter: User,
  invitation: ProjectInvitation,
  target: User,
  projectSlug: string,
): Promise<{ status: 'sent' | 'not_configured' | 'rate_limited' | 'failed' }> {
  if (!env.EMAIL || !target.email) {
    return { status: 'not_configured' };
  }
  try {
    if (!(await consumeInvitationEmailDelivery(env.ROUTING, invitation.project_id))) {
      return { status: 'rate_limited' };
    }
    await sendProjectInvitationEmail(env, {
      to: target.email,
      invitationId: invitation.id,
      projectSlug,
      inviterLogin: inviter.login,
      role: invitation.role,
    });
    return { status: 'sent' };
  } catch (error) {
    console.error('[api] project invitation email delivery failed', {
      invitationId: invitation.id,
      error,
    });
    return { status: 'failed' };
  }
}

/**
 * Approximate per-project delivery limit. KV can briefly undercount concurrent
 * requests across colos, which is acceptable for an email abuse guard. The
 * counter is consumed before sending so provider failures cannot be retried to
 * generate unlimited delivery attempts.
 */
async function consumeInvitationEmailDelivery(
  kv: KVNamespace,
  projectId: string,
): Promise<boolean> {
  const now = new Date();
  const minuteKey = `project-invitation-email-rate:${projectId}:${minuteBucket(now)}`;
  const dayKey = `project-invitation-email-rate:${projectId}:${dayBucket(now)}`;
  const [minuteRaw, dayRaw] = await Promise.all([kv.get(minuteKey), kv.get(dayKey)]);
  const minuteCount = parseCounter(minuteRaw);
  const dayCount = parseCounter(dayRaw);

  if (minuteCount >= INVITATION_EMAILS_PER_MINUTE || dayCount >= INVITATION_EMAILS_PER_DAY) {
    return false;
  }
  await Promise.all([
    kv.put(minuteKey, String(minuteCount + 1), { expirationTtl: 5 * 60 }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 25 * 60 * 60 }),
  ]);
  return true;
}

const projectInput = type({ projectId: 'string' });
const members = canOnProject('members');
const membersAuthz = { policy: 'project-members', check: members } as const;

export const listMembers = procedure('team.members')
  .use(signedInMember)
  .input(projectInput)
  .authz({ policy: 'project-read', check: canOnProject('read') })
  .output(type({ members: memberView.array(), 'warnings?': 'string[]' }))
  .noErrors({ reason: 'A project always lists at least its owner' })
  .mcp({ description: 'List a project’s members', effect: 'read', idempotent: true })
  .cli({ command: 'team list', description: 'List project members' })
  .handler(async ({ ctx, input }) => {
    const access = grantedAccess(ctx);
    const rows = await getProjectMembers(ctx.db, input.projectId);
    const warnings = await proxyTokenRotationWarnings(
      ctx.db,
      input.projectId,
      access.role,
      !!ctx.credential.project,
    );
    const result: MembersResult = {
      members: [
        { user: summary(access.owner), role: 'owner', created_at: access.project.created_at },
        ...rows.map(({ member, user }) => memberJson(member, user)),
      ],
    };
    if (warnings.length > 0) {
      result.warnings = [...warnings];
    }
    return result;
  });

export const listInvitations = procedure('team.invitations')
  .use(signedInMember)
  .input(projectInput)
  .authz(membersAuthz)
  .output(type({ invitations: invitationView.array() }))
  .noErrors({ reason: 'A project with no invitations returns an empty list' })
  .mcp({ description: 'List a project’s invitations', effect: 'read', idempotent: true })
  .cli({ command: 'team invitations', description: 'List project invitations' })
  .handler(async ({ ctx, input }) => {
    const invitations = await getProjectInvitations(ctx.db, input.projectId);
    const targets = await getUsersByIds(
      ctx.db,
      invitations.map((invitation) => invitation.target_user_id),
    );
    const targetsById = new Map(targets.map((target) => [target.id, target]));
    return {
      invitations: invitations.flatMap((invitation) => {
        const target = targetsById.get(invitation.target_user_id);
        return target ? [invitationJson(invitation, target)] : [];
      }),
    };
  });

export const invite = procedure('team.invite')
  .use(signedInMember)
  .input(type({ projectId: 'string', email: 'string', role }))
  .authz(membersAuthz)
  .output(type({ invitation: invitationView, refreshed: 'boolean', delivery }))
  .errors(ERRORS)
  .mcp({ description: 'Invite a registered user to a project', effect: 'write' })
  .cli({ command: 'team invite', description: 'Invite a registered user to a project' })
  .handler(async ({ env, ctx, input, fail }) => {
    const email = input.email.trim().toLowerCase();
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      return fail('INVALID_EMAIL');
    }
    try {
      const result = await createOrRefreshProjectInvitation(ctx.db, {
        projectId: input.projectId,
        email,
        role: input.role,
        actorUserId: ctx.user.id,
      });
      return {
        invitation: invitationJson(result.invitation, result.target),
        refreshed: result.refreshed,
        delivery: await deliverInvitation(
          env,
          ctx.user,
          result.invitation,
          result.target,
          grantedAccess(ctx).project.slug,
        ),
      };
    } catch (error) {
      return fail(mutationCode(error));
    }
  });

export const resend = procedure('team.resendInvitation')
  .use(signedInMember)
  .input(type({ projectId: 'string', invitationId: 'string' }))
  .authz(membersAuthz)
  .output(type({ invitation: invitationView, delivery }))
  .errors(ERRORS)
  .mcp({ description: 'Resend a project invitation', effect: 'write' })
  .cli({ command: 'team resend', description: 'Resend a project invitation' })
  .handler(async ({ env, ctx, input, fail }) => {
    try {
      const result = await resendProjectInvitation(ctx.db, {
        projectId: input.projectId,
        invitationId: input.invitationId,
        actorUserId: ctx.user.id,
      });
      return {
        invitation: invitationJson(result.invitation, result.target),
        delivery: await deliverInvitation(
          env,
          ctx.user,
          result.invitation,
          result.target,
          grantedAccess(ctx).project.slug,
        ),
      };
    } catch (error) {
      return fail(mutationCode(error));
    }
  });

export const revoke = procedure('team.revokeInvitation')
  .use(signedInMember)
  .input(type({ projectId: 'string', invitationId: 'string' }))
  .authz(membersAuthz)
  .output(type({ ok: 'true' }))
  .errors(ERRORS)
  .mcp({ description: 'Revoke a pending project invitation', effect: 'destructive' })
  .cli({ command: 'team revoke', description: 'Revoke a project invitation' })
  .handler(async ({ ctx, input, fail }) => {
    try {
      await revokeProjectInvitation(ctx.db, {
        projectId: input.projectId,
        invitationId: input.invitationId,
        actorUserId: ctx.user.id,
      });
      return { ok: true } as const;
    } catch (error) {
      return fail(mutationCode(error));
    }
  });

export const setRole = procedure('team.setRole')
  .use(signedInMember)
  .input(type({ projectId: 'string', userId: 'string', role }))
  .authz(membersAuthz)
  .output(type({ member: memberView }))
  .errors(ERRORS)
  .mcp({ description: 'Change a project member’s role', effect: 'write', idempotent: true })
  .cli({ command: 'team role', description: 'Change a project member’s role' })
  .handler(async ({ env, ctx, input, fail }) => {
    try {
      const { member, cancelledBuilds } = await setProjectMemberRole(ctx.db, {
        projectId: input.projectId,
        subjectUserId: input.userId,
        role: input.role,
        actorUserId: ctx.user.id,
      });
      await cancelContainerBuildDos(
        env,
        cancelledBuilds,
        'github connection authorizer lost admin access',
      );
      const user = await getUser(ctx.db, member.user_id);
      return user ? { member: memberJson(member, user) } : fail('MEMBER_NOT_FOUND');
    } catch (error) {
      return fail(mutationCode(error));
    }
  });

export const removeMember = procedure('team.remove')
  .use(signedInMember)
  .input(type({ projectId: 'string', userId: 'string' }))
  .authz(membersAuthz)
  .output(type({ ok: 'true' }))
  .errors(ERRORS)
  .mcp({ description: 'Remove a member from a project', effect: 'destructive' })
  .cli({ command: 'team remove', description: 'Remove a project member' })
  .handler(async ({ env, ctx, input, fail }) => {
    try {
      const { cancelledBuilds } = await removeProjectMember(ctx.db, {
        projectId: input.projectId,
        subjectUserId: input.userId,
        actorUserId: ctx.user.id,
      });
      await cancelContainerBuildDos(
        env,
        cancelledBuilds,
        'github connection authorizer removed from project',
      );
      return { ok: true } as const;
    } catch (error) {
      return fail(mutationCode(error));
    }
  });

export const leave = procedure('team.leave')
  .use(signedInMember)
  .input(projectInput)
  .authz({ policy: 'project-read', check: canOnProject('read') })
  .output(type({ ok: 'true' }))
  .errors(ERRORS)
  .noMcp({ reason: 'Leaving a project is the member’s own decision' })
  .cli({ command: 'team leave', description: 'Leave a project' })
  .handler(async ({ env, ctx, input, fail }) => {
    if (grantedAccess(ctx).role === 'owner') {
      return fail('OWNER_CANNOT_LEAVE');
    }
    try {
      const { cancelledBuilds } = await removeProjectMember(ctx.db, {
        projectId: input.projectId,
        subjectUserId: ctx.user.id,
        actorUserId: ctx.user.id,
      });
      await cancelContainerBuildDos(
        env,
        cancelledBuilds,
        'github connection authorizer removed from project',
      );
      return { ok: true } as const;
    } catch (error) {
      return fail(mutationCode(error));
    }
  });

export const myInvitations = procedure('team.myInvitations')
  .use(signedInMember)
  .noAuthz({ reason: 'Lists only invitations addressed to the caller' })
  .noInput()
  .output(
    type({
      invitations: type({
        id: 'string',
        project: { id: 'string', slug: 'string', owner: { id: 'string', login: 'string | null' } },
        invited_by: { id: 'string', login: 'string | null' },
        role: 'string',
        created_at: 'string',
        expires_at: 'string',
      }).array(),
    }),
  )
  .noErrors({ reason: 'No invitations returns an empty list' })
  .noMcp({ reason: 'Invitations are answered by the person they were sent to' })
  .cli({ command: 'team pending', description: 'List invitations sent to you' })
  .handler(async ({ ctx }) => {
    const invitations = await getPendingProjectInvitationsByUserId(ctx.db, ctx.user.id);
    const projectIds = Array.from(new Set(invitations.map((invitation) => invitation.project_id)));
    const projects = await getProjectsByIds(ctx.db, projectIds);
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const users = await getUsersByIds(
      ctx.db,
      Array.from(
        new Set([
          ...projects.map((project) => project.user_id),
          ...invitations.map((invitation) => invitation.invited_by_user_id),
        ]),
      ),
    );
    const usersById = new Map(users.map((user) => [user.id, user]));
    return {
      invitations: invitations.flatMap((invitation) => {
        const project = projectsById.get(invitation.project_id);
        if (!project) {
          return [];
        }
        const owner = usersById.get(project.user_id);
        const inviter = usersById.get(invitation.invited_by_user_id);
        return [
          {
            id: invitation.id,
            project: {
              id: project.id,
              slug: project.slug,
              owner: owner ? summary(owner) : { id: project.user_id, login: null },
            },
            invited_by: inviter
              ? summary(inviter)
              : { id: invitation.invited_by_user_id, login: null },
            role: invitation.role,
            created_at: invitation.created_at,
            expires_at: invitation.expires_at,
          },
        ];
      }),
    };
  });

export const respond = procedure('team.respond')
  .use(signedInMember)
  .noAuthz({
    reason: 'The invitation names its target, and the mutation refuses any other account',
  })
  .input(type({ invitationId: 'string', response: "'accept' | 'decline'" }))
  .output(type({ 'member?': memberView }))
  .errors(ERRORS)
  .noMcp({ reason: 'Invitations are answered by the person they were sent to' })
  .cli({ command: 'team respond', description: 'Accept or decline an invitation' })
  .handler(async ({ ctx, input, fail }) => {
    try {
      const result = await respondToProjectInvitation(ctx.db, {
        invitationId: input.invitationId,
        actorUserId: ctx.user.id,
        response: input.response,
      });
      if (input.response === 'decline') {
        return {};
      }
      if (!result.member) {
        throw new Error('accepted project invitation has no membership');
      }
      return { member: memberJson(result.member, ctx.user) };
    } catch (error) {
      return fail(mutationCode(error));
    }
  });
