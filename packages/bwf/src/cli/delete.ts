import { log, text, isCancel, cancel } from '@voidzero-dev/vite-plus-prompts';
import { getApiUrl, getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { printSuccess, createSpinner, note } from './output.ts';
import { readProjectConfig, removeProjectConfig } from './project.ts';
import { resolveProjectBySlug } from './resolve-project.ts';

export async function runDeleteCommand(
  root: string,
  slug?: string,
  options?: { force?: boolean },
): Promise<void> {
  console.log();

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `bwf account login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  let projectId: string;
  let projectSlug: string;

  if (slug) {
    const projects = await client.listProjects();
    const config = resolveProjectBySlug(projects, slug);
    if (!config) {
      log.error(`project: No project found with slug '${slug}'.`);
      process.exit(1);
    }
    projectId = config.projectId;
    projectSlug = config.slug;
  } else {
    const config = readProjectConfig(root);
    if (!config) {
      log.error('No linked project found. Pass a project name: bwf project delete <name>');
      process.exit(1);
    }
    // Decision: A project id belongs to the platform that issued it, the same as in deploy.
    const apiUrl = getApiUrl(root);
    if (config.platformUrl !== apiUrl) {
      log.error(
        `project: This project is linked to ${config.platformUrl}. Pass a project name to delete one on ${apiUrl}: bwf project delete <name>`,
      );
      process.exit(1);
    }
    projectId = config.projectId;
    projectSlug = config.slug;
  }

  if (!options?.force) {
    note(
      [
        'Worker deployments',
        'D1 databases, KV namespaces, R2 buckets',
        'Static assets',
        'Deployment history',
      ].join('\n'),
      `Deleting ${projectSlug} will permanently remove`,
    );

    const confirmation = await text({
      message: `Type "${projectSlug}" to confirm deletion:`,
      validate(value) {
        if (value !== projectSlug) {
          return `Please type "${projectSlug}" exactly to confirm.`;
        }
      },
    });

    if (isCancel(confirmation)) {
      cancel('Delete cancelled.');
      process.exit(0);
    }
  }

  const s = createSpinner();
  s.start('Deleting project...');

  const result = await client.deleteProject(projectId);

  s.clear();

  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      log.warn(warning);
    }
  }

  const localConfig = readProjectConfig(root);
  if (localConfig?.projectId === projectId) {
    removeProjectConfig(root);
    log.step('Removed local .bwf/project.json');
  }

  printSuccess(`Deleted ${projectSlug}`);
}
