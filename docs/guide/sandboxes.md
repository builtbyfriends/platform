---
description: 'Run commands, work with files, and connect to servers inside an isolated Cloudflare Sandbox.'
outline: deep
---

# Sandboxes

Use a Cloudflare Sandbox to run commands, work with files, and connect to servers from server code. Each Sandbox ID selects an isolated container.

## Requirements

Cloudflare deployments require [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) and Containers access. Run Docker for local development and direct deployments that build an image. A team platform's runtime token needs Account / Containers: Edit and Account / Cloudchamber: Edit.

## Run a command

```ts
import { defineHandler } from '@builtbyfriends/bwf';
import { getSandbox } from '@builtbyfriends/bwf/sandbox';

export const POST = defineHandler(async (c) => {
  const sandbox = await getSandbox('default');
  const result = await sandbox.run(['node', '--version']);
  return c.json({
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
  });
});
```

Importing from `@builtbyfriends/bwf/sandbox` enables the required resources. Local development, direct Cloudflare deployments, and team platforms share the same runtime API.

## Runtime API

`getSandbox(id, options)` resolves a Sandbox without starting it. The first command, file operation, or port request starts the container. IDs contain 1–63 characters and are lowercased by default; pass `normalizeId: false` to preserve case.

```ts
import { getSandbox } from '@builtbyfriends/bwf/sandbox';

const sandbox = await getSandbox(`user-${user.id}`, {
  inactivityTimeoutMs: 10 * 60 * 1000,
  enableInternet: false,
});
const result = await sandbox.run(['node', '--version'], {
  signal: AbortSignal.timeout(5_000),
});
```

Commands take an executable and arguments as an array. For shell syntax, explicitly run `['sh', '-c', command]`. Execution options include `cwd` (default `/workspace`), `env`, `user`, `signal`, `pty`, `stdin`, `stdout`, and `stderr`.

Sandbox operations return promises. `run()` resolves with `stdout` and `stderr` as `ArrayBuffer`s and the command's exit code. Usage limits reject with [`UsageLimit`](#usage-limits); other failures reject normally.

`exec()` resolves with a process. Await `process.output()` to collect its output and exit code, or read the streams and await `process.exitCode`. Waiting for completion keeps a long command active during pauses in its output; unattended background commands can stop when the Sandbox becomes idle. A runtime limit can reject completion after a command has successfully started.

Use `stdin: 'pipe'` for a writable input stream. `kill(signal?)` stops a process, and `resize(cols, rows)` resizes its terminal.

File operations live under `sandbox.files`: `readFile`, `writeFile`, `stat`, `lstat`, `readDirectory`, `mkdir`, `rename`, and `remove`. Await `readFile()` to receive a streaming `Response`, then use `.text()`, `.arrayBuffer()`, or `.body`. `writeFile()` accepts text, binary data, or a byte stream. Relative file paths require an explicit `cwd` option.

To reach a server inside the container, await `sandbox.fetch(port, new Request(url))`. `sandbox.running()` checks whether the container is running; `sandbox.destroy()` stops it.

On native Cloudflare deployments, `sandbox.fetch()` also supports WebSocket upgrade requests. Return its response from your Worker handler to connect the client to the container. WebSocket upgrades are currently unavailable on managed bwf deployments.

`getSandbox()` options include `inactivityTimeoutMs` (default ten minutes, maximum six hours), `enableInternet` (default `false`), and string `labels`. Internet access and labels take effect on the next container start. `binding` selects a custom native binding; managed platforms use the configured binding.

### Network rules and secrets

Use `outbound` instead of `enableInternet` when a sandbox should reach only some hosts, or call an API with a key that code in the sandbox can't read:

```ts
const sandbox = await getSandbox(`task-${task.id}`, {
  outbound: {
    mode: 'hosts',
    hosts: ['registry.npmjs.org', '*.github.com'],
    secrets: [{ hosts: ['api.example.com'], header: 'authorization', value: `Bearer ${apiKey}` }],
  },
});
```

`mode` is `full` (any host), `hosts` (only the listed hosts) or `none`. A host is a lower-case name, or a pattern like `*.example.com` for its subdomains. Each secret's header is added to HTTPS requests for its hosts, outside the container, and those hosts are reachable in every mode. A plain HTTP request to a secret's host is refused.

The rules cover HTTP on port 80 and HTTPS on port 443. With `full`, other ports reach the internet directly; with `hosts` or `none`, they're closed. The sandbox trusts the certificate that the HTTPS rules need when it starts. Node.js doesn't read the system bundle, so set `NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt` in a command's `env` for Node programs.

Calling `getSandbox()` with new hosts or secrets applies them to a running sandbox. A change between `full` and the other modes takes effect on the next container start. On native Cloudflare deployments, bwf exports the handler these rules need from your Worker; a custom Sandbox Durable Object needs `export { SandboxOutboundHandler } from '@builtbyfriends/bwf/sandbox'` in its Worker.

For code that runs on both deployment targets, use `getSandbox()`. Direct access through `c.env.SANDBOX` is available only on local and native Cloudflare deployments.

### Back up a directory

`backup()` saves a directory to R2 and returns a record. Keep the record, for example in your database, and pass it to `restore()` to bring the files back into a later container, or into another sandbox of the same app:

```ts
const sandbox = await getSandbox(`task-${task.id}`);
const record = await sandbox.backup({ dir: '/workspace', exclude: ['node_modules/'] });
await db.update(tasks).set({ backup: record }).where(eq(tasks.id, task.id));

// Later, in a new container:
await sandbox.restore(record);
await sandbox.deleteBackup(record);
```

Stop programs that write to the directory before a backup, because files that change while it's read are saved as they are at that moment. `restore()` swaps the directory in only after the download is checked. `gitignore: true` also skips what the directory's `.gitignore` files list. Backups don't expire on their own, so delete the ones you no longer need.

On a bwf platform, backups belong to the project, so a later deployment can restore them, and deleting the project removes them. On native Cloudflare deployments and in local development, add an R2 bucket binding named `SANDBOX_BACKUPS`; bwf exports the `DirectoryBackupGateway` the backups need from your Worker. A managed deployment made before backups existed needs a redeploy first.

## Usage limits

Sandbox limits reject with `SandboxLimitError`, which extends `UsageLimit` from `@builtbyfriends/bwf/limits`. The error includes `resource: 'sandbox'` and a `reason` of `concurrency` or `runtime_budget`. bwf route handlers and Pages actions automatically send a structured HTTP 429 when the error is left uncaught.

Use `instanceof UsageLimit` to optionally handle both AI and Sandbox limits, or `instanceof SandboxLimitError` for Sandbox-specific handling:

```ts
import { defineHandler } from '@builtbyfriends/bwf';
import { UsageLimit } from '@builtbyfriends/bwf/limits';
import { getSandbox } from '@builtbyfriends/bwf/sandbox';

export const POST = defineHandler(async (c) => {
  const sandbox = await getSandbox('default');
  try {
    const result = await sandbox.run(['node', 'task.mjs']);
    return c.json({ exitCode: result.exitCode });
  } catch (error) {
    if (error instanceof UsageLimit) {
      return error.response({
        message: 'Execution is temporarily unavailable. Try again shortly.',
      });
    }
    throw error;
  }
});
```

Keep user input available so it can be retried. Checking `running()`, stopping a process, and `destroy()` remain available after a usage limit.

## State persistence

`getSandbox(id)` selects the same Durable Object for that ID within a deployment. Native Cloudflare deployments preserve that namespace across Worker versions. Each managed platform deployment has its own namespace; rolling back to a retained deployment reconnects to that deployment's namespace.

Files, running processes, and listening servers last only as long as the container. It can stop after inactivity, crash, or restart. Save anything you need to keep in your database, KV, or R2, or [back up a directory](#back-up-a-directory). Deleting a project on a bwf platform removes both its Durable Objects and containers.

## Configuration

The default environment provides Node.js 26 on Debian Trixie. Managed platform deploys use Cloudflare's managed Node.js image.

Use `bwf.config.ts` when you need a custom image or container size:

```ts
import { defineConfig } from '@builtbyfriends/bwf/config';

export default defineConfig({
  sandbox: {
    image: './Dockerfile.sandbox',
    platformImage: 'registry.cloudflare.com/<account-id>/sandbox@sha256:<digest>',
    instanceType: 'standard-1',
  },
});
```

See the [configuration reference](../reference/config.md#sandbox) for binding names, image settings, and container sizes.

Custom images must include the helper matching bwf's installed Sandbox SDK version. The SDK image supplies this binary, but is not a runnable environment itself:

```dockerfile
FROM node:26.12.1-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.2 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

For a managed platform, push your custom image to that platform account's Cloudflare registry and set `platformImage` to its digest-pinned reference. If `image` is already a Cloudflare registry reference, it also becomes the default `platformImage`. External registries and mutable tags are not supported. See [Cloudflare's image management guide](https://developers.cloudflare.com/containers/guides/image-management/#push-images-to-the-cloudflare-registry).

## Deployment

`bwf deploy --platform cloudflare` builds native images and deploys the Sandbox alongside the application. `bwf deploy` on a connected bwf Platform applies the platform's Sandbox concurrency and runtime limits.
