import { existsSync } from 'node:fs';
import { confirm, isCancel } from '@voidzero-dev/vite-plus-prompts';
import { join } from 'pathslash';
import { stashCloudflareDeployPointer } from '../cloudflare-config.ts';
import { readConfig } from '../config.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { getApiUrl, getToken, getTokenSource } from './auth.ts';
import { isExpiredTokenError, PlatformClient } from './client.ts';
import { maybeLinkCloudflareDeploy } from './cloudflare-link.ts';
import { withRecordedReadinessAccessOrigin } from './cloudflare-readiness.ts';
import { runCloudflareDeploy } from './deploy-cloudflare.ts';
import {
  log,
  assertProjectDeployAccess,
  createProjectFromSlug,
  promptDeployProjectConfig,
  resolveStaticDeployPreset,
  getGitCommit,
  resolveStaticBuildCommand,
} from './deploy-helpers.ts';
import { runFullDeploy } from './deploy-managed-full.ts';
import { runStaticDeploy } from './deploy-managed-static.ts';
import { printDeployContext } from './deploy-summary.ts';
import type { RunDeployOptions, RunDeployTargetAdapter } from './deploy-types.ts';
import { collectGitDeployMetadata } from './git-metadata.ts';
import {
  exchangeGithubOidcForDeployToken,
  isGithubActionsOidcAvailable,
  maskGithubActionsSecret,
} from './github-oidc.ts';
import { assertInstalledBwfMatchesCli } from './installed-platform.ts';
import { openDeployLog } from './log-file.ts';
import type { CliLogger } from './log-file.ts';
import { buildDeployLogSummary } from './log-summary.ts';
import { promptForLoginToken } from './login.ts';
import { migrateLegacyBwfConfig } from './migrate.ts';
import { listPlatformConnections } from './platform-registry.ts';
import { detectPreset } from './preset.ts';
import { readDeploymentPlatform, readProjectConfig } from './project.ts';
import type { DeploymentPlatform, ProjectConfig } from './project.ts';
import { getRequestedProjectSlug } from './resolve-project.ts';
import type { DeployTarget } from './types.ts';

export function resolveDeploymentPlatform(
  root: string,
  options?: RunDeployOptions,
): DeploymentPlatform {
  // Decision: Projects with no saved choice predate the init prompt and keep the bwf default.
  return options?.platform ?? readDeploymentPlatform(root) ?? 'platform';
}

/** Run `bwf deploy`; a failure carries a summary of the deploy log in its message. */
export async function runDeploy(root: string, options?: RunDeployOptions): Promise<void> {
  // Decision: The Cloudflare link check can evaluate bwf.config.ts, so record operator input first.
  options = withRecordedReadinessAccessOrigin(options ?? {});
  console.log();

  const cliLog = openDeployLog({
    mirrorToStderr: options?.debug === true || process.env.BWF_DEPLOY_DEBUG === '1',
  });
  cliLog.info('deploy_start', {
    cwd: root,
    projectSlug: options?.projectSlug,
    dir: options?.dir,
    spa: options?.spa === true ? true : undefined,
    skipBuild: options?.skipBuild === true ? true : undefined,
    skipMigrations: options?.skipMigrations === true ? true : undefined,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  try {
    await runDeployInner(root, options, cliLog);
    cliLog.info('deploy_end', { ok: true });
  } catch (error) {
    cliLog.error('deploy_end', error, { ok: false });
    // Decision: Flush before reading the file back. The `Detailed log:` path is useless on a CI runner that's
    // destroyed with the job, so inline the errors and the trailing timeline into the message the caller
    // prints.
    await cliLog.close().catch(() => {});
    try {
      if (error instanceof Error) {
        const summary = buildDeployLogSummary(cliLog.path);
        if (summary) {
          error.message = `${error.message}\n${summary}`;
        }
      }
    } catch {
      // Decision: A postmortem aid mustn't replace the failure it describes. The assignment alone can throw:
      // `message` is read-only on a frozen Error and getter-only on a DOMException, which an aborted fetch
      // produces. Losing the summary is fine; losing the deploy error isn't.
    }
    throw error;
  } finally {
    await cliLog.close().catch(() => {});
  }
}

const cloudflareDeployTarget: RunDeployTargetAdapter = {
  target: 'cloudflare',
  async deploy(root, options, cliLog): Promise<void> {
    if (options.projectSlug !== undefined) {
      throw new Error(
        'deploy: --project is not supported with platform cloudflare — this platform deploys to your own Cloudflare account and no bwf project is involved.',
      );
    }
    assertInstalledBwfMatchesCli(root);
    if (migrateLegacyBwfConfig(root)) {
      log.step(
        'Migrated project configuration to bwf.config.ts. Commit bwf.config.ts and bwf.lock.json.',
      );
    }
    if (options.preview !== undefined || options.removePreview !== undefined) {
      // Decision: The preview code loads arktype, which adds about 250 ms to every bwf start, so only a preview command loads it.
      const { runCloudflarePreview } = await import('./deploy-cloudflare-preview.ts');

      return runCloudflarePreview(root, options, cliLog);
    }
    return runCloudflareDeploy(root, options, cliLog);
  },
};

const bwfDeployTarget: RunDeployTargetAdapter = {
  target: 'platform',
  deploy: runManagedDeploy,
};

const deployTargets: Record<DeployTarget, RunDeployTargetAdapter> = {
  cloudflare: cloudflareDeployTarget,
  platform: bwfDeployTarget,
};

async function runDeployInner(
  root: string,
  options: RunDeployOptions | undefined,
  cliLog: CliLogger,
): Promise<void> {
  const link = await maybeLinkCloudflareDeploy(root, options);
  if (link === 'cancelled') {
    log.info('Deployment cancelled.');
    return;
  }
  if (link === 'existing') {
    options = { ...options, platform: 'cloudflare', reuseExistingWorker: true };
  }
  const platform = resolveDeploymentPlatform(root, options);
  if (options?.atomic && platform !== 'cloudflare') {
    throw new Error('deploy: --atomic is available only for Cloudflare Workers.');
  }

  if (platform === 'none') {
    throw new Error(
      'deploy: deployment setup was skipped during `bwf init`. Pass `--platform cloudflare` or `--platform bwf` to choose a destination.',
    );
  }

  cliLog.info('deploy_target', { target: platform });

  try {
    return await deployTargets[platform].deploy(root, options ?? {}, cliLog);
  } finally {
    if (existsSync(join(root, 'bwf.config.ts'))) {
      stashCloudflareDeployPointer(root);
    }
  }
}

async function runManagedDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
): Promise<void> {
  // Decision: Resolve the connected recipient before credentials, OIDC, builds or platform requests.
  const apiUrl = getApiUrl(root);
  const requestedProjectSlug = getRequestedProjectSlug(options);
  let reauthenticated = false;
  let displayedProject: string | undefined;
  while (true) {
    try {
      // Decision: Project IDs and implicit slugs belong to the platform that issued them.
      // Read again after reauthentication: this attempt may have set up its first link.
      const savedProject = readProjectConfig(root);
      const linkedProject = savedProject?.platformUrl === apiUrl ? savedProject : null;
      if (savedProject && !linkedProject && !requestedProjectSlug) {
        throw new Error(
          `deploy: This project is linked to ${savedProject.platformUrl}. Pass --project <slug> to deploy to ${apiUrl} without changing the saved link.`,
        );
      }
      // Decision: Token precedence: BWF_TOKEN, then GitHub Actions OIDC, then the saved login. OIDC has to beat the
      // saved login so a leftover `bwf account login` on a reused runner can't preempt it.
      let token = process.env.BWF_TOKEN ? getToken(root) : null;
      if (!token && isGithubActionsOidcAvailable()) {
        // Decision: A workflow with `id-token: write` intends OIDC, so an unknown slug is a hard error, not a
        // fallback to the saved login.
        const slug = requestedProjectSlug ?? linkedProject?.slug;
        if (!slug) {
          throw new Error(
            'deploy: running in GitHub Actions but the project is unknown — pass --project <slug> or link the project.',
          );
        }
        cliLog.info('github_oidc_exchange_start', { slug });
        const tokenOrigin = getApiUrl(root);
        token = await exchangeGithubOidcForDeployToken(tokenOrigin, slug);
        maskGithubActionsSecret(token);
        // Decision: Treat the exchanged token like an explicit CI token; `buildEnv()` still removes it from each
        // project-controlled child.
        process.env.BWF_TOKEN = token;
        process.env.BWF_API_URL = tokenOrigin;
        cliLog.info('github_oidc_exchange_success', { slug });
      }
      token ??= getToken(root);
      if (!token) {
        log.error('No auth token found. Run `bwf account login` first.');
        process.exit(1);
      }

      // Decision: Access credentials stay in `process.env` for the expired-token re-auth below; `buildEnv()`
      // removes them from each project-controlled child.
      const client = new PlatformClient(token, { root, cliLog });
      if (options.skipMigrations) {
        await client.requireMigrationSkipSupport();
      }

      // Decision: Target project precedence: CLI flag, then env var, then the linked project file.
      let config: ProjectConfig | null = null;

      if (requestedProjectSlug) {
        // Decision: Most deploys already have a project ID. The single-project endpoint avoids account-wide history
        // and traffic queries even when CI also sets BWF_PROJECT to the linked slug.
        const linked =
          linkedProject?.slug === requestedProjectSlug
            ? await client.getProject(linkedProject.projectId)
            : null;
        const project =
          linked?.slug === requestedProjectSlug
            ? linked
            : await client.findProjectBySlug(requestedProjectSlug);
        assertProjectDeployAccess(project ?? undefined);
        config = project ? { projectId: project.id, slug: project.slug } : null;

        if (!config) {
          if (!process.stdin.isTTY) {
            // Decision: In CI, auto-create when --project is given explicitly.
            config = await createProjectFromSlug(root, client, requestedProjectSlug, cliLog);
          } else {
            const shouldCreate = await confirm({
              message: `Project "${requestedProjectSlug}" does not exist. Create it?`,
            });
            if (isCancel(shouldCreate) || !shouldCreate) {
              log.info('Deploy cancelled.');
              process.exit(0);
            }

            config = await createProjectFromSlug(root, client, requestedProjectSlug, cliLog);
          }
        }
      } else {
        config = linkedProject;
        if (config) {
          const { projectId, slug } = config;
          const project = await client.getProject(projectId);
          if (!project) {
            throw new Error(
              `deploy: The linked project "${slug}" is unavailable or you no longer have access. ` +
                'Ask a project admin or owner to restore access, or choose another project with `--project <slug>`.',
            );
          }
          assertProjectDeployAccess(project);
        }
      }

      if (!config && !process.stdin.isTTY) {
        log.error(
          'No project specified. Set `BWF_PROJECT`, pass `--project <slug>`, or commit `.bwf/project.json`.',
        );
        process.exit(1);
      }

      if (!config) {
        config = await promptDeployProjectConfig(root, client, cliLog);
      }

      cliLog.info('project_resolved', {
        projectId: config.projectId,
        slug: config.slug,
      });
      if (displayedProject !== config.slug) {
        const destination =
          listPlatformConnections().find((connection) => connection.apiUrl === apiUrl)
            ?.displayName ?? new URL(apiUrl).hostname;
        printDeployContext(config.slug, destination);
        displayedProject = config.slug;
      }

      if (migrateLegacyBwfConfig(root)) {
        log.step(
          'Migrated project configuration to bwf.config.ts. Commit bwf.config.ts and bwf.lock.json.',
        );
      }

      // Decision: App type precedence: bwf.config.ts, then CLI flags, then auto-detection.
      const bwfConfig = readConfig(root);
      cliLog.info('config_resolved', { appType: bwfConfig.inference?.appType });

      let preset = resolveStaticDeployPreset(root, bwfConfig, {
        dir: options?.dir,
        spa: options?.spa,
      });

      // Decision: Read the git commit before the build (only when not skipping it). Same scrub as `getGitCommit`:
      // these git children can reach repo-configured hooks and credential helpers.
      const gitMetadata = collectGitDeployMetadata(
        root,
        options?.skipBuild ? null : getGitCommit(root),
        process.env,
        buildEnv(),
      );
      if (!preset && !bwfConfig.inference?.appType) {
        // Decision: No configured app type, so detect from project structure. `strictBackend` is set only here: on
        // this branch the user has said nothing about the app type, so an SSG project that also has a
        // backend is ambiguous and has to be refused, not quietly deployed as static. The explicit-intent
        // paths (`--dir`, configured `inference.appType`) resolve through `resolveStaticDeployPreset` above
        // and keep working without the guard.
        preset = detectPreset(root, { spa: options?.spa, strictBackend: true });
      }

      if (preset) {
        preset = {
          ...preset,
          buildCommand: resolveStaticBuildCommand(
            preset,
            bwfConfig.inference?.build,
            Boolean(options?.dir),
          ),
        };
        await runStaticDeploy(
          root,
          config,
          client,
          preset,
          options?.skipBuild,
          gitMetadata,
          bwfConfig.routing,
          cliLog,
        );
      } else {
        await runFullDeploy(
          root,
          config,
          client,
          bwfConfig,
          options?.skipBuild,
          gitMetadata,
          cliLog,
          options.skipMigrations,
        );
      }
      return;
    } catch (error) {
      if (isExpiredTokenError(error)) {
        if (getTokenSource() === 'ci') {
          throw new Error(
            '`BWF_TOKEN` is invalid or expired. Generate a new token and try again.',
            { cause: error },
          );
        }
        if (!process.stdin.isTTY || reauthenticated) {
          throw new Error('Auth token expired. Run `bwf account login` and try again.', {
            cause: error,
          });
        }
        log.warn('Auth token expired. Re-authenticating...');
        await promptForLoginToken(root);
        log.step('Re-authenticated. Retrying deploy...');
        reauthenticated = true;
        continue;
      }
      throw error;
    }
  }
}

export { type RunDeployOptions } from './deploy-types.ts';

export { parseRootWranglerConfig } from '@builtbyfriends/deploy-cloudflare';
export { resolveDeployTransport } from './deploy-transport.ts';
export { deriveWorkerName } from './deploy-resources.ts';
export { checkWranglerMigrationApplySet } from './deploy-migrations.ts';
export {
  createDeployWranglerRunner,
  isWranglerNonInteractiveOrCI,
  runWranglerAuthToken,
} from './deploy-cloudflare-auth.ts';
export { discoverRootWranglerConfig } from './deploy-cloudflare.ts';
