import { type } from 'arktype';
import {
  getAccessibleProjectBySlug,
  getAccessibleProjectsByUserId,
  getDomainsByProjectIds,
  getLatestDeploymentsByProjectIds,
  getProjectResources,
} from '../../db.ts';
import { isDevBypass } from '../../env.ts';
import { sortProjectList } from '../../project-list.ts';
import type { ProjectListItem } from '../../project-list.ts';
import { projectWithUrl } from '../../project-url.ts';
import { ProjectCreateError, createProjectForUser } from '../../routes/projects.ts';
import { getRequestsDataset, queryProjectRequestOverview } from '../../routes/usage.ts';
import { canOnProject, grantedAccess } from '../access.ts';
import { member, procedure } from '../procedure.ts';

const projectIdInput = type({ projectId: 'string' });
const owner = { id: 'string', login: 'string' } as const;
const projectView = type({ id: 'string', slug: 'string', role: 'string', owner });

export const create = procedure('projects.create')
  .use(member)
  .noAuthz({ reason: 'Every signed in user may create projects on their own account' })
  .input(type({ slug: 'string' }))
  .output(
    type({
      id: 'string',
      slug: 'string',
      'url?': 'string',
      'warnings?': 'string[]',
      'zero_trust?': 'object | null',
      'owner_email_destination?': { address: 'string' },
    }),
  )
  .errors({
    SLUG_INVALID: { status: 400, message: 'slug is not a valid project name' },
    SLUG_SHORT_NOT_ALLOWED: { status: 403, message: 'slug is too short for this plan' },
    SLUG_TAKEN: { status: 409, message: 'slug already taken' },
    PLATFORM_UNINSTALLING: { status: 409, message: 'new projects cannot be created now' },
    AI_LOGGING_UNAVAILABLE: { status: 503, message: 'AI logging could not be applied' },
  })
  .mcp({ description: 'Create a project with the given slug', effect: 'write' })
  .cli({ command: 'project create', description: 'Create a project' })
  .handler(async ({ env, ctx, input, fail, waitUntil }) => {
    try {
      return await createProjectForUser(
        {
          env,
          db: ctx.db,
          user: ctx.user,
          // Decision: Unlike Hono's executionCtx, this waitUntil doesn't throw, so there's no inline fallback.
          schedule: async (work) => waitUntil(work),
        },
        input.slug,
      );
    } catch (error) {
      if (error instanceof ProjectCreateError) {
        return fail(error.code, error.message);
      }
      throw error;
    }
  });

export const list = procedure('projects.list')
  .use(member)
  .noAuthz({ reason: 'Lists only projects the caller can already access' })
  .noInput()
  .output(type({ id: 'string', slug: 'string', role: 'string', owner }).array())
  .noErrors({ reason: 'An empty list is a valid answer, not an error' })
  .mcp({
    description: 'List your projects with traffic and latest deployment',
    effect: 'read',
    idempotent: true,
  })
  .cli({ command: 'project list', description: 'List your projects' })
  .handler(async ({ env, ctx }) => {
    const all = await getAccessibleProjectsByUserId(ctx.db, ctx.user.id);
    // Decision: A scoped deploy token only needs its own project, for slug-to-id resolution. Listing the rest
    // would let a leaked build-time token read other projects' domains and traffic.
    const projects = ctx.credential.project
      ? all.filter(({ project }) => project.id === ctx.credential.project)
      : all;
    const ids = projects.map(({ project }) => project.id);
    const lookups =
      ids.length > 0
        ? await Promise.all([
            getDomainsByProjectIds(ctx.db, ids),
            getLatestDeploymentsByProjectIds(ctx.db, ids),
            isDevBypass(env)
              ? Promise.resolve(undefined)
              : queryProjectRequestOverview(
                  env.CF_ACCOUNT_ID,
                  env.CF_API_TOKEN,
                  getRequestsDataset(env),
                  ids,
                ),
          ])
        : undefined;
    return projects
      .map(({ project: p, role, owner }): ProjectListItem => {
        const pDomains = lookups?.[0].get(p.id);
        const domain =
          pDomains?.find((d: { status: string }) => d.status === 'active') ?? pDomains?.[0];
        const o = lookups?.[2]?.get(p.id);
        return {
          ...projectWithUrl(p, env),
          role,
          owner: { id: owner.id, login: owner.login },
          custom_domain: domain?.hostname ?? null,
          latest_deployment: lookups?.[1].get(p.id) ?? null,
          traffic: {
            requests5m: o?.requests5m ?? 0,
            lastSeenAt: o?.lastSeenAt ?? null,
            sparkline5m: o?.sparkline5m ?? Array.from({ length: 20 }, () => 0),
          },
          health: {
            responses4xx15m: o?.responses4xx15m ?? 0,
            responses5xx15m: o?.responses5xx15m ?? 0,
            errorRate5xx15m: o?.errorRate5xx15m ?? 0,
          },
        };
      })
      .sort(sortProjectList);
  });

export const choices = procedure('projects.choices')
  .use(member)
  .noAuthz({ reason: 'Lists only projects the caller can already access' })
  .noInput()
  .output(projectView.array())
  .noErrors({ reason: 'An empty list is a valid answer, not an error' })
  .noMcp({ reason: 'Agents use projects.list, which carries the same names' })
  .cli({ command: 'project choices', description: 'List projects without traffic summaries' })
  .handler(async ({ env, ctx }) =>
    (await getAccessibleProjectsByUserId(ctx.db, ctx.user.id)).map(({ project, role, owner }) => ({
      ...projectWithUrl(project, env),
      role,
      owner: { id: owner.id, login: owner.login },
    })),
  );

export const resolve = procedure('projects.resolve')
  .use(member)
  .noAuthz({ reason: 'Resolves only a project the caller can already access' })
  .input(type({ slug: type('string <= 56').and(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) }))
  .output(type({ project: projectView.or('null') }))
  .noErrors({ reason: 'An unknown or inaccessible slug is a valid answer: project is null' })
  .noMcp({ reason: 'Agents use projects.list, which carries the same names' })
  .cli({ command: 'project resolve', description: 'Look up one project by slug' })
  .handler(async ({ env, ctx, input }) => {
    const access = await getAccessibleProjectBySlug(ctx.db, ctx.user.id, input.slug);
    if (!access || (ctx.credential.project && ctx.credential.project !== access.project.id)) {
      return { project: null };
    }
    return {
      project: {
        ...projectWithUrl(access.project, env),
        role: access.role,
        owner: { id: access.owner.id, login: access.owner.login },
      },
    };
  });

export const get = procedure('projects.get')
  .use(member)
  .input(projectIdInput)
  .authz({ policy: 'project-read', check: canOnProject('read') })
  .output(projectView)
  .noErrors({ reason: 'A missing or hidden project is refused by the authz check' })
  .mcp({ description: 'Read one project', effect: 'read', idempotent: true })
  .cli({ command: 'project get', description: 'Show one project' })
  .handler(({ env, ctx }) => {
    const { project, role, owner } = grantedAccess(ctx);
    return { ...projectWithUrl(project, env), role, owner: { id: owner.id, login: owner.login } };
  });

export const resources = procedure('projects.resources')
  .use(member)
  .input(projectIdInput)
  .authz({ policy: 'project-read', check: canOnProject('read') })
  .output(type({ id: 'string' }).array())
  .noErrors({ reason: 'A project with no resources returns an empty list' })
  .mcp({
    description: 'List the bindings provisioned for a project',
    effect: 'read',
    idempotent: true,
  })
  .cli({ command: 'project resources', description: 'List a project’s resources' })
  .handler(async ({ ctx }) => [
    ...(await getProjectResources(ctx.db, grantedAccess(ctx).project.id)),
  ]);
