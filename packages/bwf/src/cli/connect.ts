import type { PlatformDiscoveryDocument } from '@builtbyfriends/platform';
import { isCancel, log, select } from '@voidzero-dev/vite-plus-prompts';
import { readPlatformToken } from './auth.ts';
import { isExpiredTokenError, PlatformClient } from './client.ts';
import { connectCloudflare } from './cloudflare-connect.ts';
import type { ConnectArgs } from './connect-args.ts';
import { promptForLoginToken } from './login.ts';
import { printSuccess } from './output.ts';
import { discoverPlatform, promptPlatformUrl, saveDiscoveredPlatform } from './platform-cmd.ts';
import { listPlatformConnections, normalizePlatformApiUrl } from './platform-registry.ts';
import {
  readDeploymentPlatform,
  writeDeploymentPlatform,
  writePlatformSelection,
} from './project.ts';

async function selectBwfPlatform(interactive: boolean): Promise<string> {
  if (!interactive) {
    throw new Error('connect: Supply a bwf platform URL in non-interactive mode.');
  }
  const connections = listPlatformConnections();
  if (connections.length === 0) {
    return promptPlatformUrl();
  }
  const value = await select({
    message: 'Select a bwf platform:',
    options: [
      ...connections.map((entry) => ({
        value: entry.apiUrl,
        label: entry.displayName,
        hint: entry.apiUrl,
      })),
      { value: 'new', label: 'Connect to another platform' },
    ],
  });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('connect: Cancelled.');
  }
  return value === 'new' ? promptPlatformUrl() : value;
}

async function authenticateConnection(
  root: string,
  discovery: PlatformDiscoveryDocument,
  interactive: boolean,
): Promise<void> {
  // Decision: An environment token is usable only when it's explicitly bound to this origin. Project metadata
  // and another saved platform mustn't select its recipient.
  const envToken = process.env.BWF_TOKEN;
  const envUrl = process.env.BWF_API_URL;
  const matchingEnv = Boolean(
    envToken && envUrl && normalizePlatformApiUrl(envUrl) === discovery.apiUrl,
  );
  const token = matchingEnv ? envToken : readPlatformToken(discovery.apiUrl);
  if (token) {
    try {
      // Decision: Login has to work on any platform version.
      await new PlatformClient(token, {
        apiUrl: discovery.apiUrl,
        checkPlatformVersion: false,
      }).whoami();
      log.step(`Authenticated with ${discovery.displayName}.`);
      return;
    } catch (error) {
      if (!isExpiredTokenError(error)) {
        throw error;
      }
      if (matchingEnv) {
        throw new Error('connect: BWF_TOKEN is invalid or expired. Replace it before connecting.', {
          cause: error,
        });
      }
    }
  }
  if (!interactive) {
    throw new Error(
      'connect: Set BWF_TOKEN and a matching BWF_API_URL, or use --no-login to save the connection without authenticating.',
    );
  }
  await promptForLoginToken(root, discovery);
}

export async function runConnectCommand(
  root: string,
  args: ConnectArgs,
  interactive: boolean = Boolean(process.stdin.isTTY),
): Promise<void> {
  let target = args.platform ?? (args.url || args.noLogin ? 'platform' : null);
  if (!target) {
    if (!interactive) {
      throw new Error('connect: Supply a platform URL or --platform cloudflare|platform.');
    }
    const value = await select({
      message: 'Where should this project deploy?',
      initialValue: readDeploymentPlatform(root) === 'platform' ? 'platform' : 'cloudflare',
      options: [
        {
          value: 'cloudflare',
          label: 'Cloudflare',
          hint: 'Deploy to your own Cloudflare account.',
        },
        { value: 'platform', label: 'Platform', hint: "Deploy to your company's bwf Platform." },
      ],
    });
    if (isCancel(value)) {
      throw new Error('connect: Cancelled.');
    }
    target = value as 'cloudflare' | 'platform';
  }
  if (target === 'cloudflare') {
    await connectCloudflare(root, interactive);
    writeDeploymentPlatform(root, 'cloudflare');
    printSuccess('Connected to Cloudflare. Run `bwf deploy` to deploy this project.');
    return;
  }
  const discovery = await discoverPlatform(args.url || (await selectBwfPlatform(interactive)));
  if (!args.noLogin) {
    await authenticateConnection(root, discovery, interactive);
  }
  saveDiscoveredPlatform(discovery);
  const envUrl = process.env.BWF_API_URL;
  const environmentOverrides = Boolean(
    envUrl && normalizePlatformApiUrl(envUrl) !== discovery.apiUrl,
  );
  const selected = environmentOverrides ? false : writePlatformSelection(root, discovery);
  if (!selected) {
    log.info(
      'Saved the connection. The current project link or environment still selects its existing destination.',
    );
  }
  if (args.noLogin) {
    log.info(
      'Connection saved without login. Run `bwf account login` in a project using this platform when ready.',
    );
  } else if (selected) {
    log.info('Run `bwf project link` to select a project, then `bwf deploy`.');
  }
  printSuccess(`Connected to ${discovery.displayName} at ${discovery.apiUrl}.`);
}
