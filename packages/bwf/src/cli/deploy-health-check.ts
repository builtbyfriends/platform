import { spawn } from 'node:child_process';
import {
  scrubManagedDeployBuildMarkers,
  scrubWranglerAuthCredentials,
} from './deploy-transport.ts';

const HEALTH_CHECK_TIMEOUT_MS = 180_000;

/** The env a project's health command runs with: its address, and no Cloudflare credentials. */
export function healthCheckEnv(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...scrubManagedDeployBuildMarkers(scrubWranglerAuthCredentials({ ...env })),
    BWF_DEPLOY_URL: url,
  };
}

/**
 * Run the command named in `deploy.cloudflare.healthCheck` against a deployed address. It passes when the command exits 0.
 * The deploy decides what a failure means, since a production deploy is already live by then and a preview is not.
 */
export function runHealthCheck(
  command: string,
  url: string,
  root: string,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: root,
      env: healthCheckEnv(url),
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
      timeout: HEALTH_CHECK_TIMEOUT_MS,
    });

    child.on('error', (error) => resolve({ ok: false, detail: error.message }));
    child.on('close', (code, signal) =>
      resolve(
        code === 0
          ? { ok: true, detail: '' }
          : {
              ok: false,
              detail: signal ? `stopped by ${signal}` : `exited with code ${String(code)}`,
            },
      ),
    );
  });
}
