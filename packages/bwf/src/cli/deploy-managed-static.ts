import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { RoutingConfig } from '../config.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import type { PlatformClient } from './client.ts';
import { log } from './deploy-helpers.ts';
import {
  mergeAndLintRoutingRules,
  streamDirectR2Deploy,
  warnUnpublishedRouting,
} from './deploy-managed-events.ts';
import { formatDeploySummary, printDeploySuccess } from './deploy-summary.ts';
import { MANAGED_DEPLOY_BUILD_ENV } from './deploy-transport.ts';
import type { GitDeployMetadata } from './git-metadata.ts';
import type { CliLogger } from './log-file.ts';
import { createSpinner, formatCount, note } from './output.ts';
import { collectAndHashAssets, buildStaticManifest } from './package.ts';
import type { StaticPreset } from './preset.ts';
import type { ProjectConfig } from './project.ts';

export async function runStaticDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  preset: StaticPreset,
  skipBuild?: boolean,
  gitMetadata?: GitDeployMetadata,
  routing?: RoutingConfig,
  cliLog?: CliLogger,
): Promise<void> {
  const typeLabel = preset.appType === 'spa' ? 'Static SPA' : 'Static Site';
  log.info(`${typeLabel} deploy`);
  cliLog?.info('deploy_mode', { mode: 'static', appType: preset.appType });

  if (preset.buildCommand && !skipBuild) {
    log.step('Building...');
    cliLog?.info('build_start', { command: preset.buildCommand });
    const buildStartedAt = Date.now();
    execSync(preset.buildCommand, {
      cwd: root,
      stdio: 'inherit',
      env: buildEnv({ ...MANAGED_DEPLOY_BUILD_ENV }, { localBinRoot: root }),
    });
    cliLog?.info('build_end', { durationMs: Date.now() - buildStartedAt });
  } else if (skipBuild) {
    cliLog?.info('build_skipped', { reason: 'skipBuild' });
  }

  if (!existsSync(preset.outputDir)) {
    log.error(`deploy: Output directory '${preset.outputDir}' not found. Run the build first.`);
    process.exit(1);
  }

  const { headerRules, redirectRules, fallbackRules } = mergeAndLintRoutingRules(
    preset.outputDir,
    routing,
  );

  const s = createSpinner();
  const onProgress = (msg: string) => s.message(msg);

  // Decision: `assetFiles` carries the in-memory buffer cache so the upload step uses the same bytes that were
  // hashed.
  s.start('Checking for changes...');
  cliLog?.info('preflight_start', { dir: preset.outputDir });
  const { assetManifest, assetFiles } = await collectAndHashAssets(preset.outputDir, onProgress);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest);
  s.stop('Checked for changes');
  cliLog?.info('preflight_end', {
    total: Object.keys(assetManifest).length,
    needed: needed.length,
    skipped,
  });

  if (skipped > 0) {
    log.info(`Skipping ${formatCount(skipped, 'unchanged asset')}`);
  }

  s.start('Packaging...');
  cliLog?.info('package_start', { mode: 'static' });
  const packageStartedAt = Date.now();

  const manifest = buildStaticManifest({
    appType: preset.appType,
    alwaysUseHttps: routing?.alwaysUseHttps,
    hashedAssetsPrefix: 'assets',
    headerRules,
    redirectRules,
    fallbackRules,
    notFound: routing?.notFound,
  });
  cliLog?.info('package_end', {
    mode: 'static',
    durationMs: Date.now() - packageStartedAt,
  });
  const result = await streamDirectR2Deploy({
    client,
    projectId: config.projectId,
    manifest,
    assetManifest,
    assetFiles,
    needed,
    gitMetadata,
    preflightUsed: skipped > 0,
    spinner: s,
    cliLog,
  });

  note(
    formatDeploySummary({ typeLabel, assets: result.assets, unchangedAssets: skipped }),
    result.url,
  );

  warnUnpublishedRouting(result);
  printDeploySuccess(result.published !== false);
}
