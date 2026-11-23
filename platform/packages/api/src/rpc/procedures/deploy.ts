import { type } from 'arktype';
import { sql } from 'drizzle-orm';
import { findMissingR2Assets, persistedR2AssetSizes } from '../../asset-inventory.ts';
import { activeOAuthApproval, OAuthError } from '../../auth/oauth.ts';
import { uploadPool } from '../../concurrency.ts';
import { getDeployment, getProject } from '../../db.ts';
import type { Db } from '../../db.ts';
import { requireActiveDeployAccess } from '../../deploy/recovery.ts';
import {
  HEX_32_REGEX,
  MAX_UPLOAD_URLS_BATCH,
  moduleContentType,
  workerUploadModulesProblem,
} from '../../deploy/shared.ts';
import type { UploadUrlsRequestAsset, WorkerUploadModule } from '../../deploy/shared.ts';
import { deploymentInputPrefix } from '../../deployment-execution.ts';
import { cliVersionProblem } from '../../middleware/cli-version.ts';
import { createDeployLogger } from '../../observability/logger.ts';
import { ProjectAccessDeniedError } from '../../project-access.ts';
import {
  ProjectRequiresNormalizationError,
  requireNormalizedProject,
} from '../../project-state.ts';
import { presignAssetPut } from '../../r2-presign.ts';
import { canOnProject, grantedAccess } from '../access.ts';
import { member, procedure } from '../procedure.ts';
import type { Caller } from '../procedure.ts';

// Decision: 30 minutes. On a slow uplink a tail asset can wait in the upload pool for more than 10 minutes
// before its first PUT, and the CLI treats R2's 403 SignatureExpired as terminal.
const UPLOAD_URL_TTL_SECONDS = 1800;

// Decision: Presigning is CPU-light; 50 in flight keeps tail latency bounded without 5000 async tasks.
const PRESIGN_BATCH_CONCURRENCY = 50;

/** Why a deploy-side procedure refuses a project it otherwise reaches. */
const ADMISSION_ERRORS = {
  PROJECT_DELETING: { status: 410, message: 'project is being deleted' },
  PROJECT_NEEDS_NORMALIZATION: { status: 409, message: 'project needs normalization' },
  ACCESS_DENIED: { status: 403, message: 'project access denied' },
  CLI_OUTDATED: { status: 426, message: 'the void CLI is too old' },
  APPROVAL_REFUSED: { status: 403, message: 'publish approval refused' },
} as const;

type Refusal = { code: keyof typeof ADMISSION_ERRORS; message?: string };

/** The fast gates every deploy procedure shares, before any work or lock. */
async function admit(caller: Caller, request: Request): Promise<Refusal | null> {
  const { project } = grantedAccess(caller);
  if (project.status === 'deleting') {
    return { code: 'PROJECT_DELETING' };
  }
  // Decision: Run this after authz and the deleting check, so a stale CLI on a missing, foreign or deleting
  // project sees that more specific answer, not an upgrade notice.
  const outdated = cliVersionProblem(
    request.headers.get('content-type'),
    request.headers.get('x-platform-cli-version'),
  );
  if (outdated) {
    return { code: 'CLI_OUTDATED', message: outdated.message };
  }
  try {
    await requireNormalizedProject(caller.db, project);
  } catch (error) {
    if (error instanceof ProjectRequiresNormalizationError) {
      return { code: 'PROJECT_NEEDS_NORMALIZATION', message: error.message };
    }
    throw error;
  }
  return null;
}

/**
 * Runs `presign` while holding the project's share lock, so teardown (which takes the row
 * exclusively) waits until every URL is issued. Presigning is pure HMAC, so the lock is short.
 * Returns the refusal, or null once every URL is issued.
 */
async function presignUnderProjectLock(
  caller: Caller,
  projectId: string,
  presign: (tx: Db, signingKeyCache: Map<string, ArrayBuffer>) => Promise<void>,
): Promise<Refusal | null> {
  try {
    await caller.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR SHARE`);
      // Decision: A teardown may have committed between the unlocked admission and this lock.
      const locked = await getProject(tx, projectId);
      if (!locked || locked.status === 'deleting') {
        throw new ProjectDeleting();
      }
      await requireActiveDeployAccess(tx, projectId, caller.user.id);
      await requireNormalizedProject(tx, locked);
      // Decision: Derived signing keys are the same within this request; release them with the batch.
      await presign(tx, new Map());
    });
  } catch (error) {
    if (error instanceof OAuthError) {
      return { code: 'APPROVAL_REFUSED', message: error.message };
    }
    if (error instanceof ProjectAccessDeniedError) {
      return { code: 'ACCESS_DENIED' };
    }
    if (error instanceof ProjectRequiresNormalizationError) {
      return { code: 'PROJECT_NEEDS_NORMALIZATION', message: error.message };
    }
    if (error instanceof ProjectDeleting) {
      return { code: 'PROJECT_DELETING' };
    }
    throw error;
  }
  return null;
}

class ProjectDeleting extends Error {}

const url = type({ url: 'string', headers: 'Record<string, string>' });

export const preflight = procedure('deploy.preflight')
  .use(member)
  .input(
    type({
      projectId: 'string',
      assetManifest: 'Record<string, object>',
      'hasWorker?': 'boolean',
    }),
  )
  .authz({ policy: 'project-deploy', check: canOnProject('deploy') })
  .output(type({ needed: 'string[]', total: 'number', skipped: 'number' }))
  .errors(ADMISSION_ERRORS)
  .noMcp({ reason: 'Deploys come from the CLI, which builds the asset manifest' })
  .cli({ command: 'deploy preflight', description: 'List the assets a deploy still has to upload' })
  .handler(async ({ env, ctx, input, fail, request }) => {
    const refused = await admit(ctx, request);
    if (refused) {
      return fail(refused.code, refused.message);
    }
    const { project } = grantedAccess(ctx);
    const manifest = input.assetManifest as Record<string, { hash: string; size: number }>;
    const total = Object.keys(manifest).length;
    // Decision: Both static and Worker deployments need the platform-owned scoped R2 copy. Provider asset dedup
    // and historical KV placement don't prove it holds these bytes.
    const valid =
      total <= MAX_UPLOAD_URLS_BATCH &&
      Object.values(manifest).every(
        (entry) =>
          entry &&
          typeof entry.hash === 'string' &&
          HEX_32_REGEX.test(entry.hash) &&
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0,
      );
    if (!valid) {
      return { needed: Object.keys(manifest), total, skipped: 0 };
    }
    const active = project.active_deployment_id
      ? await getDeployment(ctx.db, project.active_deployment_id)
      : null;
    const activeSizes =
      active?.status === 'live' && active.project_id === project.id
        ? persistedR2AssetSizes(active.asset_hashes)
        : new Map<string, number>();
    const unverified = Object.fromEntries(
      Object.entries(manifest).filter(([, entry]) => activeSizes.get(entry.hash) !== entry.size),
    );
    const needed = await findMissingR2Assets(env.STATIC_ASSETS_R2, project.id, unverified);
    return { needed, total, skipped: total - needed.length };
  });

const asset = type({
  blake3: /^[0-9a-f]{32}$/,
  md5: /^[0-9a-f]{32}$/,
  size: 'number.integer >= 0',
  contentType: 'string > 0',
});

export const uploadUrls = procedure('deploy.uploadUrls')
  .use(member)
  .input(type({ projectId: 'string', assets: asset.array().atMostLength(MAX_UPLOAD_URLS_BATCH) }))
  .authz({ policy: 'project-deploy', check: canOnProject('deploy') })
  .output(type({ urls: type({ '[string]': url }) }))
  .errors(ADMISSION_ERRORS)
  .noMcp({ reason: 'Deploys come from the CLI, which uploads the asset bytes' })
  .cli({ command: 'deploy upload-urls', description: 'Presign R2 uploads for deploy assets' })
  .handler(async ({ env, ctx, input, fail, request }) => {
    const refused = await admit(ctx, request);
    if (refused) {
      return fail(refused.code, refused.message);
    }
    const { project } = grantedAccess(ctx);
    const { approval: approvalId, expiresAt } = ctx.credential;
    const logger = createDeployLogger({
      projectId: project.id,
      projectSlug: project.slug,
      userId: ctx.user.id,
      branch: null,
    });
    const urls: Record<string, { url: string; headers: Record<string, string> }> = {};
    const failed = await presignUnderProjectLock(ctx, project.id, async (tx, signingKeyCache) => {
      if (approvalId) {
        const { approval } = await activeOAuthApproval(tx, approvalId, ctx.companyIdentity, true);
        // Decision: JSON keeps tuple boundaries and field types, so malformed approval metadata can't match a valid
        // upload through coercion.
        const key = (a: Pick<UploadUrlsRequestAsset, 'blake3' | 'md5' | 'size'>) =>
          JSON.stringify([a.blake3, a.md5, a.size]);
        const approved = new Set(Object.values(approval.data.artifact!.assetManifest).map(key));
        if (
          approval.data.projectId !== project.id ||
          input.assets.some((a) => !approved.has(key(a)))
        ) {
          throw new OAuthError(
            'access_denied',
            'Upload only the assets approved for this publish.',
            403,
          );
        }
      }
      await uploadPool(input.assets, PRESIGN_BATCH_CONCURRENCY, async (a) => {
        // Decision: Last write wins when two paths share a blake3: both point at the same key.
        urls[a.blake3] = await presignAssetPut(
          {
            accountId: env.CF_ACCOUNT_ID,
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            bucket: env.R2_STATIC_ASSETS_BUCKET,
            key: `assets/${project.id}/${a.blake3}`,
            md5: a.md5,
            contentType: a.contentType,
            ttlSeconds: approvalId
              ? Math.max(1, Math.min(900, expiresAt! - Math.floor(Date.now() / 1000)))
              : UPLOAD_URL_TTL_SECONDS,
            ...(approvalId ? { ifNoneMatch: '*' as const, contentLength: a.size } : {}),
          },
          signingKeyCache,
        );
      });
    });
    if (failed) {
      return fail(failed.code, failed.message);
    }
    logger.info('upload_urls', 'response', { assetCount: input.assets.length });
    return { urls };
  });

export const workerUploadUrls = procedure('deploy.workerUploadUrls')
  .use(member)
  .input(
    type({
      projectId: 'string',
      modules: type({ name: 'string', size: 'number.integer >= 0', sha256: 'string' }).array(),
    }),
  )
  .authz({ policy: 'project-deploy', check: canOnProject('deploy') })
  .output(type({ id: 'string', urls: url.array() }))
  .errors({
    ...ADMISSION_ERRORS,
    INVALID_MODULES: { status: 400, message: 'invalid Worker modules' },
    WORKER_TOO_LARGE: { status: 413, message: 'the Worker is too large' },
  })
  .noMcp({ reason: 'Deploys come from the CLI, which uploads the Worker modules' })
  .cli({
    command: 'deploy worker-upload-urls',
    description: 'Presign R2 uploads for Worker modules',
  })
  .handler(async ({ env, ctx, input, fail, request }) => {
    const refused = await admit(ctx, request);
    if (refused) {
      return fail(refused.code, refused.message);
    }
    const problem = workerUploadModulesProblem(input.modules, 'modules');
    if (problem) {
      return fail(problem.error ? 'WORKER_TOO_LARGE' : 'INVALID_MODULES', problem.message);
    }
    const { project } = grantedAccess(ctx);
    const modules = input.modules as ReadonlyArray<WorkerUploadModule>;
    const id = crypto.randomUUID();
    const prefix = deploymentInputPrefix(project.id, id);
    const urls: Array<{ url: string; headers: Record<string, string> }> = [];
    // Decision: Module `i` is stored at `deployment-inputs/<project>/<id>/<i>`, a prefix that operation cleanup,
    // the stale-input sweep and project teardown already cover.
    const failed = await presignUnderProjectLock(ctx, project.id, async (_tx, signingKeyCache) => {
      await uploadPool([...modules.keys()], PRESIGN_BATCH_CONCURRENCY, async (index) => {
        const module = modules[index]!;
        urls[index] = await presignAssetPut(
          {
            accountId: env.CF_ACCOUNT_ID,
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            bucket: env.R2_STATIC_ASSETS_BUCKET,
            key: `${prefix}${index}`,
            contentType: moduleContentType(module.name),
            contentLength: module.size,
            ttlSeconds: UPLOAD_URL_TTL_SECONDS,
          },
          signingKeyCache,
        );
      });
    });
    if (failed) {
      return fail(failed.code, failed.message);
    }
    return { id, urls };
  });
