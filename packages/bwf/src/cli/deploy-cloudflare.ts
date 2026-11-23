import { readConfig } from '../config.ts';
import { readCloudflareCandidate } from './cloudflare-candidate.ts';
import { createCloudflareChildReporter } from './cloudflare-child-report.ts';
import { readCloudflareLink } from './cloudflare-link.ts';
import { withRecordedReadinessAccessOrigin } from './cloudflare-readiness.ts';
import { removeDeployPointer } from './deploy-artifact-validation.ts';
import { buildCloudflareWorker } from './deploy-cloudflare-build.ts';
import { migrateCloudflareWorker } from './deploy-cloudflare-migrate.ts';
import {
  prepareCloudflareDeploySource,
  preflightCloudflareWorker,
} from './deploy-cloudflare-preflight.ts';
import { publishCloudflareWorker } from './deploy-cloudflare-publish.ts';
import {
  resolveCloudflareStaticPreset,
  runCloudflareStaticDeploy,
} from './deploy-cloudflare-static.ts';
import { log } from './deploy-helpers.ts';
import { logD1RestoreAfterDeployFailure } from './deploy-migrations.ts';
import { printDeploySuccess } from './deploy-summary.ts';
import type { RunDeployOptions, CloudflareDeployDeps } from './deploy-types.ts';
import { renderAddressMap } from './email-cloudflare.ts';
import type { CliLogger } from './log-file.ts';

/** Deploy to the user's own Cloudflare account through the guarded native Worker flow. */
export async function runCloudflareDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps = {},
): Promise<void> {
  // Decision: readConfig evaluates bwf.config.ts in this process. Record operator input before it runs.
  options = withRecordedReadinessAccessOrigin(options);
  const initialCloudflareLink = readCloudflareLink(root);
  const initialCloudflareCandidate = readCloudflareCandidate(root);
  const exitProcess = deps.exit ?? ((code: number): never => process.exit(code));
  // Decision: Most failures leave through exit(), which skips the deploy_end that runDeploy writes on a throw.
  // Record it here. The logger keeps only the first deploy_end, so a path that already wrote one (a
  // failed activation) isn't recorded twice.
  const exit = (code: number): never => {
    if (code === 0) {
      cliLog.info('deploy_end', { ok: true, exitCode: code });
    } else {
      cliLog.error('deploy_end', undefined, { ok: false, exitCode: code });
    }
    return exitProcess(code);
  };
  // Decision: All steps below, including the static branch, read exit from deps.
  deps = { ...deps, exit };
  // Decision: One redactor for the whole deploy, so a bearer learned by one child is scrubbed everywhere.
  const reporter = createCloudflareChildReporter(cliLog);
  const bwfConfig = readConfig(root);
  const atomic = options.atomic === true || bwfConfig.deploy?.cloudflare?.mode === 'atomic';
  if (atomic && (options.reuseExistingWorker || initialCloudflareLink)) {
    log.error(
      'deploy: atomic deployment is unavailable during the existing Worker handoff. Complete the handoff first.',
    );
    return exit(1);
  }
  cliLog.info('cloudflare_deploy_start', {
    provision: options.provision === true ? true : undefined,
  });

  const staticPreset = resolveCloudflareStaticPreset(root, bwfConfig, options);
  if (staticPreset) {
    if (atomic) {
      log.error('deploy: atomic deployment is only for Workers with Durable Objects.');
      return exit(1);
    }
    return runCloudflareStaticDeploy(
      root,
      options,
      bwfConfig,
      staticPreset,
      cliLog,
      deps,
      initialCloudflareLink,
      initialCloudflareCandidate,
      reporter,
    );
  }

  const source = await prepareCloudflareDeploySource(root, options, bwfConfig);
  if (!source) {
    return exit(1);
  }
  const preflight = await preflightCloudflareWorker({
    root,
    bwfConfig,
    options,
    deps,
    exit,
    cliLog,
    reporter,
    initialCloudflareLink,
    source,
  });

  // Decision: Only a deploy pointer this build writes may pass the post-build checks.
  removeDeployPointer(root);
  const build = await buildCloudflareWorker({
    root,
    bwfConfig,
    deps,
    exit,
    atomic,
    skipMigrations: options.skipMigrations,
    source,
    preflight,
  });
  const migration = await migrateCloudflareWorker({
    root,
    deps,
    exit,
    cliLog,
    source,
    preflight,
    build,
    skipMigrations: options.skipMigrations,
  });
  // Decision: When migrations were applied, each later failure names the restore point again.
  let restoreReported = false;
  const reportRestore = () => {
    if (migration.d1RestoreCommand && !restoreReported) {
      restoreReported = true;
      logD1RestoreAfterDeployFailure(migration.d1RestoreCommand);
    }
  };
  const exitAfterMigrations = (code: number): never => {
    if (code !== 0) {
      reportRestore();
    }
    return exit(code);
  };
  try {
    await publishCloudflareWorker({
      root,
      deps,
      exit: exitAfterMigrations,
      cliLog,
      reporter,
      atomic,
      initialCloudflareCandidate,
      source,
      preflight,
      build,
      migration,
    });
  } catch (error) {
    reportRestore();
    throw error;
  }
  // Decision: A deploy without email setup already said so during preflight.
  if (preflight.emailMap) {
    log.message(renderAddressMap(preflight.emailMap));
  }
  printDeploySuccess();
}

export { discoverRootWranglerConfig } from './deploy-cloudflare-helpers.ts';
