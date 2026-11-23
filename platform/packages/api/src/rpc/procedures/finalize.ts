import { type } from 'arktype';
import { Hono } from 'hono';
import { handleManifestOnlyDeploy } from '../../deploy/execute.ts';
import type { ApiEnv } from '../../env.ts';
import { canOnProject } from '../access.ts';
import { member, procedure } from '../procedure.ts';

/** What a refused deploy answers with, by the HTTP status the admission pipeline chose. */
const ERRORS = {
  INVALID_DEPLOY: { status: 400, message: 'the deploy request is invalid' },
  DEPLOY_REFUSED: { status: 403, message: 'the deploy credential cannot deploy this project' },
  DEPLOY_IN_PROGRESS: { status: 409, message: 'deploy in progress' },
  PROJECT_NEEDS_NORMALIZATION: {
    status: 409,
    message: 'the project needs normalizing before it can deploy',
  },
  ZERO_TRUST_NOT_READY: { status: 409, message: 'zero trust protection is not ready' },
  DEPLOY_CONFLICT: { status: 409, message: 'the deploy conflicts with the project state' },
  PROJECT_DELETING: { status: 410, message: 'project is being deleted' },
  CAPABILITY_UNAVAILABLE: { status: 501, message: 'this platform does not enable that capability' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'the deploy request is too large' },
  CLI_OUTDATED: { status: 426, message: 'the void CLI is too old' },
  DEPLOY_RATE_LIMITED: { status: 429, message: 'too many deploys; retry later' },
  DEPLOY_UNAVAILABLE: { status: 503, message: 'deploys are unavailable right now' },
} as const;

type Code = keyof typeof ERRORS;

function codeFor(status: number, body: { deployment?: unknown; error?: unknown }): Code | null {
  switch (status) {
    case 400:
      return 'INVALID_DEPLOY';
    case 403:
      return 'DEPLOY_REFUSED';
    case 409:
      if (typeof body.deployment === 'string') {
        return 'DEPLOY_IN_PROGRESS';
      }
      if (body.error === 'project_requires_normalization') {
        return 'PROJECT_NEEDS_NORMALIZATION';
      }
      if (body.error === 'zero trust not ready') {
        return 'ZERO_TRUST_NOT_READY';
      }
      return 'DEPLOY_CONFLICT';
    case 410:
      return 'PROJECT_DELETING';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 501:
      return 'CAPABILITY_UNAVAILABLE';
    case 426:
      return 'CLI_OUTDATED';
    case 429:
      return 'DEPLOY_RATE_LIMITED';
    case 503:
      return 'DEPLOY_UNAVAILABLE';
    default:
      return null;
  }
}

export const finalize = procedure('deploy.finalize')
  .use(member)
  .input(
    type({
      projectId: 'string',
      /** The deployment's manifest, assets and Worker input: the body `bwf deploy` assembles. */
      body: 'object',
      /** Retrying with the same key returns the same deployment. */
      'idempotencyKey?': /^[A-Za-z0-9_-]{1,128}$/,
    }),
  )
  .authz({ policy: 'project-deploy', check: canOnProject('deploy') })
  .output(
    type({
      /** Absent when an inline deploy was refused before it was given an ID. */
      'deploymentId?': 'string',
      /** Without the Queue the deploy runs inside the request: its events, in order. */
      'events?': 'object[]',
    }),
  )
  .errors(ERRORS)
  .noMcp({ reason: 'Deploys come from the CLI, which builds the manifest' })
  .cli({ command: 'deploy finalize', description: 'Start a deployment from an uploaded manifest' })
  .handler(async ({ env, ctx, input, fail, request, waitUntil }) => {
    // Decision: Reuse the admission pipeline that `executeQueuedDeployment` already enters through a Hono app, so
    // it runs unchanged here: same gates, idempotency and queue dispatch.
    const deployApp = new Hono<ApiEnv>()
      .use('*', async (context, next) => {
        context.set('db', ctx.db);
        context.set('user', ctx.user);
        context.set('tokenAudience', ctx.credential.audience);
        if (ctx.credential.project) {
          context.set('deployScope', ctx.credential.project);
        }
        if (ctx.credential.build) {
          context.set('deployBuild', ctx.credential.build);
        }
        if (ctx.credential.credentialId) {
          context.set('deployCredential', ctx.credential.credentialId);
        }
        if (ctx.credential.approval) {
          context.set('oauthApproval', ctx.credential.approval);
        }
        if (ctx.credential.expiresAt) {
          context.set('deployTokenExpiresAt', ctx.credential.expiresAt);
        }
        if (ctx.companyIdentity) {
          context.set('companyIdentity', ctx.companyIdentity);
        }
        await next();
      })
      .post('/:id/deploy', handleManifestOnlyDeploy);
    const cliVersion = request.headers.get('x-platform-cli-version');
    const response = await deployApp.fetch(
      new Request(`https://deploy.invalid/${input.projectId}/deploy`, {
        method: 'POST',
        headers: {
          'content-type': request.headers.get('content-type') ?? 'application/json',
          ...(cliVersion ? { 'x-platform-cli-version': cliVersion } : {}),
          ...(input.idempotencyKey
            ? { 'x-platform-deploy-idempotency-key': input.idempotencyKey }
            : {}),
        },
        body: JSON.stringify(input.body),
      }),
      env,
      { waitUntil, passThroughOnException() {}, props: {} },
    );
    if (!response.ok) {
      const text = await response.text();
      let body: { error?: unknown; message?: unknown; deployment?: unknown } = {};
      try {
        body = JSON.parse(text) as typeof body;
      } catch {}
      const code = codeFor(response.status, body);
      if (!code) {
        throw new Error(`deploy admission failed with HTTP ${response.status}: ${text}`);
      }
      const detail =
        typeof body.message === 'string'
          ? body.message
          : typeof body.error === 'string'
            ? body.error
            : undefined;
      return fail(
        code,
        code === 'DEPLOY_IN_PROGRESS'
          ? `${detail ?? 'deploy in progress'}: deployment ${String(body.deployment)}`
          : detail,
      );
    }
    // Decision: With the Queue, the receipt header names a deployment the Queue owns, so drop the stream and let
    // the caller watch it. Without the Queue, the deploy runs inside this response: read it to the end
    // and return its events, the first of which names the deployment.
    const receipt = response.headers.get('x-platform-deployment-id');
    if (env.DEPLOYMENTS_QUEUE && receipt) {
      await response.body?.cancel().catch(() => {});
      return { deploymentId: receipt };
    }
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { event?: string; deploymentId?: string });
    const deploymentId = receipt ?? events.find((event) => event.event === 'start')?.deploymentId;
    if (!deploymentId && !events.some((event) => event.event === 'error')) {
      throw new Error('deploy admission returned no deployment receipt');
    }
    return { ...(deploymentId ? { deploymentId } : {}), events };
  });
