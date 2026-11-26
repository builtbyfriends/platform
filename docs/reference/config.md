---
description: 'Configure routing, inference, resources, and deployment in bwf.config.ts.'
outline: deep
---

# Config

## Config File Format

Use `bwf.config.ts` to configure your app. For a guided introduction, start with [What is bwf?](../guide/).

Put `bwf.config.ts` at the project root and import `defineConfig` from `@builtbyfriends/bwf/config`. All fields are optional. `bwf init`, `bwf deploy`, and `bwf migrate` can convert older bwf and Cloudflare JSON config files, saving backups under `.bwf/config-migration/`. Commit `bwf.config.ts` and `bwf.lock.json` when bwf creates the lock; it records resource IDs and migration history.

```ts
// bwf.config.ts
import { defineConfig } from '@builtbyfriends/bwf/config';

export default defineConfig({
  sourceDir: 'src',
  auth: { providers: ['email', 'github', 'google'] },
  routing: {
    headers: {
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
      '/*': ['X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff'],
    },
  },
  inference: {
    bindings: { db: true, kv: false },
    appType: 'spa',
    outputDir: 'dist',
  },
  worker: {
    compatibility_date: '2025-12-01',
    compatibility_flags: ['nodejs_compat'],
  },
  cloudflare: {
    name: 'my-app',
    account_id: 'your-account-id',
  },
});
```

TypeScript provides editor completion and checks. bwf validates the config again when it runs, including values computed at runtime.

Use relative imports or package names inside `bwf.config.ts`. TypeScript path aliases such as `@/lib/theme` are not supported.

The shorter JSON fragments below show individual fields to place inside `defineConfig({ ... })`.

## Fields

### `sourceDir`

Directory containing bwf source conventions, relative to the project root.

When omitted, bwf uses the existing project-root conventions: `routes/`, `middleware/`, `crons/`, `queues/`, `db/`, `auth.ts`, and `env.ts`.

When set, those conventions move under the configured directory:

```json
{ "sourceDir": "src" }
```

With that config, bwf reads `src/routes`, `src/db/schema.ts`, `src/db/migrations`, `src/auth.ts`, and `src/env.ts`. Project files such as `bwf.config.ts`, `vite.config.ts`, `package.json`, `tsconfig.json`, `public/`, and the local-only `.env` stay at the project root. bwf does not scan both locations; if source conventions exist in both places during dev/build, remove one copy so the active source tree is unambiguous.

### `procedureTypes`

Path, relative to the project root, of a types-only `.d.ts` file that `bwf prepare` writes with the input, output and error codes of every procedure. Include it in a web workspace that has no `procedures/` folder so `rpc` is typed there. Needs TypeScript 7 or later. See [Typing `rpc` in a separate web workspace](../guide/procedures.md#typing-rpc-in-a-separate-web-workspace).

```ts
export default defineConfig({
  procedureTypes: '../web/src/procedures.d.ts',
});
```

### `ai`

Set `ai.gateway` to the Cloudflare AI Gateway used by `ai.provider().fetch()` on your own Cloudflare account. `ai.run()`, `ai.stream()`, and `ai.image()` use the Workers AI binding. On a bwf platform, the platform selects the gateway.

```json
{ "ai": { "gateway": "my-gateway" } }
```

See [AI on your Cloudflare account](../integrations/cloudflare.md#ai-self-host).

### `auth`

High-level Better Auth configuration.

Use `auth.providers` to select which built-in auth providers bwf should enable by default. Include `"email"` for email/password auth. Social providers read credentials from `AUTH_<PROVIDER>_CLIENT_ID` and `AUTH_<PROVIDER>_CLIENT_SECRET`. `cognito` also needs a domain, region, and user pool ID: set `AUTH_COGNITO_DOMAIN`, `AUTH_COGNITO_REGION`, and `AUTH_COGNITO_USER_POOL_ID`, or set them in `auth.ts`.

```json
{
  "auth": {
    "providers": ["email", "github", "google", "discord"]
  }
}
```

If `auth` is omitted but auth is active via imports, bwf enables email/password only. For provider-specific options, scopes, plugins, or custom OAuth flows, use a root `auth.ts` with `defineAuth(...)`.

Supported values for `auth.providers`:

- `email`
- `apple`
- `atlassian`
- `cognito`
- `discord`
- `dropbox`
- `facebook`
- `figma`
- `github`
- `gitlab`
- `google`
- `huggingface`
- `kakao`
- `kick`
- `line`
- `linear`
- `linkedin`
- `microsoft`
- `naver`
- `notion`
- `paybin`
- `paypal`
- `polar`
- `railway`
- `reddit`
- `roblox`
- `salesforce`
- `slack`
- `spotify`
- `tiktok`
- `twitch`
- `twitter`
- `vercel`
- `vk`
- `zoom`

### `database`

Database backend. Omit for D1/SQLite (default). Set to `"pg"` or `"mysql"` for an external database through Hyperdrive.

```json
{
  "database": "pg"
}
```

| Value       | Description                                            |
| ----------- | ------------------------------------------------------ |
| _(omitted)_ | D1 (SQLite), fully managed by bwf with no extra config |
| `"pg"`      | PostgreSQL via Hyperdrive; bring your own database     |
| `"mysql"`   | MySQL via Hyperdrive; bring your own database          |

Use an object to also set how Drizzle names columns declared without a name:

```json
{
  "database": { "dialect": "pg", "casing": "snake_case" }
}
```

| Key               | Values                                  | Description                                                                                                                                                                                       |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dialect`         | `"sqlite"` (default), `"pg"`, `"mysql"` | Database backend. `"sqlite"` is D1                                                                                                                                                                |
| `casing`          | `"snake_case"`, `"camelCase"`           | [Drizzle casing](https://orm.drizzle.team/docs/sql-schema-declaration#camel-and-snake-casing) for `@builtbyfriends/bwf/db` queries and `bwf db` commands. Omit to use each key as its column name |
| `readReplication` | `boolean` (optional)                    | D1 only. Turn [read replication](../guide/database/d1.md#read-replication) on (`true`) or off (`false`) at deploy. Leave it out to keep the current setting; new databases start with it off      |

When using an external database:

- Add `DATABASE_URL` to `.env` for local development
- Import schema helpers from `@builtbyfriends/bwf/schema-pg` or `@builtbyfriends/bwf/schema-mysql`
- `@builtbyfriends/bwf/db` connects via Hyperdrive in production, direct connection locally
- `bwf gen model` generates dialect-appropriate table and column builders

### `email`

Configuration for the [email integration](../guide/email.md).

```json
{
  "email": {
    "from": "Acme <noreply@mail.acme.com>"
  }
}
```

| Field  | Type     | Description                                                                                                    |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `from` | `string` | Default sender for `sendEmail()`: one address, optionally with a display name (`Acme <noreply@mail.acme.com>`) |

During development, `email.from` is the default sender in the local inbox. On a bwf platform, use your project's shared sender or registered domain.

For direct Cloudflare deployment, this address selects the mail domain and default sender. Use a zone or subdomain in your account; an existing mail provider's MX records are preserved. Without `email.from`, bwf skips automatic setup and preserves authored `cloudflare.send_email` bindings and `cloudflare.addresses`; check their readiness yourself. `--require-email` still refuses deployment when automatic setup cannot be verified. See [Email setup](../guide/email/domains.md#your-own-cloudflare-account).

### `remote`

Use a deployed bwf project's D1, KV, and R2 resources during local development. Writes affect real data. See [Remote Development](../guide/remote-dev.md).

```json
{ "remote": true }
```

**Requirements:**

- Must be logged in (`bwf account login`)
- Must have a linked project (`bwf project link`)
- Only affects D1 (`DB`), KV (`KV`), and R2 (`STORAGE`) bindings

You can also enable remote mode via the `BWF_REMOTE=1` environment variable without modifying `bwf.config.ts`:

```bash
BWF_REMOTE=1 pnpm dev
```

### `sandbox`

Enable and configure Cloudflare Sandboxes. Importing from `@builtbyfriends/bwf/sandbox` enables this automatically.

```json
{
  "sandbox": {
    "image": "./Dockerfile.sandbox",
    "platformImage": "registry.cloudflare.com/<account-id>/sandbox@sha256:<digest>",
    "instanceType": "standard-1"
  }
}
```

| Field               | Type     | Default                     |
| ------------------- | -------- | --------------------------- |
| `durableObject`     | `string` | None                        |
| `binding`           | `string` | `SANDBOX`                   |
| `className`         | `string` | `SandboxV1`                 |
| `containerName`     | `string` | `platform-sandbox-v1`       |
| `image`             | `string` | Packaged Node.js Dockerfile |
| `imageBuildContext` | `string` | Directory of `image`        |
| `platformImage`     | `string` | `cloudflare/debian-trixie`  |
| `instanceType`      | `string` | `lite`                      |

Supported sizes are `lite`, `basic`, and `standard-1` through `standard-4`. Native deploys build Dockerfiles with Docker; registry images must be digest-pinned references from the Cloudflare managed registry. Custom images must include the matching Sandbox SDK helper. For a local Dockerfile, supply `platformImage` when deploying to a managed platform. See [Sandboxes](../guide/sandboxes.md) for image setup and runtime examples.

Set `durableObject` to a file name in `durable-objects/` (for example `"bot"`) to attach the container image to that class instead of bwf's `SandboxV1`. The class must use `this.ctx.container`; its binding and class come from the file, so `binding` and `className` must be omitted. It needs a native Cloudflare deploy: managed platforms run containers in their own controller, so use `getSandbox` from `@builtbyfriends/bwf/sandbox` there.

Sandbox requires [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) and Containers access. Managed runtime tokens need Account / Containers: Edit and Account / Cloudchamber: Edit. See [Sandbox deployment](../guide/sandboxes.md#deployment).

### `storage.locationHint`

Choose a preferred region when bwf creates your app's R2 bucket, on either a bwf platform or a direct Cloudflare deployment:

```json
{ "storage": { "locationHint": "apac" } }
```

Supported hints are `apac` (Asia Pacific), `eeur` (Eastern Europe), `enam` (Eastern North America), `weur` (Western Europe), `wnam` (Western North America), and `oc` (Oceania). Cloudflare treats these as [best-effort location hints](https://developers.cloudflare.com/r2/reference/data-location/), not data residency guarantees.

The project setting overrides the platform's default. Without either, Cloudflare chooses automatically. This only affects new buckets: changing the hint never moves or replaces an existing bucket. Apps that do not use R2 create no bucket.

### `worker`

Cloudflare Workers settings, including the `compatibility_date` pinned by `bwf init`. Put binding arrays such as `d1_databases`, `kv_namespaces`, and `r2_buckets` in [`cloudflare`](#cloudflare).

| Field                 | Type       | Description                            |
| --------------------- | ---------- | -------------------------------------- |
| `compatibility_date`  | `string`   | Cloudflare Workers compatibility date  |
| `compatibility_flags` | `string[]` | Cloudflare Workers compatibility flags |
| `vars`                | `object`   | Plain-text worker variables            |
| `limits`              | `object`   | Worker resource limit overrides        |

```json
{
  "worker": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"],
    "vars": {
      "PUBLIC_API_BASE": "https://api.example.com"
    }
  }
}
```

`worker.vars` values must be strings. Root `.env` values override them during local development only. Production builds do not load `.env`, and reject any `worker.vars` name declared as a server key in `env.ts`. Use `bwf secret put` for production server values.

Managed deployments include `worker.vars` as plain-text bindings. A remote secret with the same name takes precedence. To use the configured variable instead, remove that remote secret and deploy again. Secret deletion changes the running Worker immediately, so plan this migration during a maintenance window.

`worker.limits.cpu_ms` sets the CPU time limit per request, from 1 to 300000 ms. On a bwf platform, deploy fails if the limit exceeds the account plan; lower it in `bwf.config.ts` before retrying. Rollback instead caps the old limit at the current plan ceiling. On direct deploys, [Cloudflare enforces the value](https://developers.cloudflare.com/workers/platform/limits/#cpu-time): Workers Free allows up to 10 ms and Workers Paid up to 300000 ms per request.

```json
{
  "worker": {
    "limits": {
      "cpu_ms": 30000
    }
  }
}
```

### `cloudflare`

The complete Cloudflare Worker configuration for direct Cloudflare builds and deployment. Put custom bindings, `name`, `account_id`, routes, services, vars, migrations, and any other Cloudflare fields here. bwf passes these fields through to the generated Cloudflare build configuration. Settings you edit here take precedence over values bwf previously recorded in `bwf.lock.json`.

```ts
// Inside defineConfig({ ... })
cloudflare: {
  name: 'my-app',
  d1_databases: [{ binding: 'ANALYTICS', database_name: 'analytics', database_id: '...' }],
  vars: { PUBLIC_API_BASE: 'https://api.example.com' },
},
```

bwf writes a generated Cloudflare config for its tooling and records provisioned resource IDs and append-only migration history in `bwf.lock.json`. Commit the lock when it changes. Root `wrangler.jsonc` and `wrangler.json` are migrated on `bwf init` or `bwf deploy`; bwf keeps backup copies under `.bwf/config-migration/`.

Bindings declared here are typed on `c.env` after `bwf prepare` or starting a dev server or build. See [Custom Binding Types](../guide/type-safety.md#custom-binding-types) for an example and RPC type overrides.

If you need to remove a value that bwf previously generated, remove it from the `resolved` object in `bwf.lock.json`. bwf refreshes the generated Cloudflare file on the next command. Put ongoing custom settings in `cloudflare` in `bwf.config.ts`.

### `deploy.cloudflare.mode`

Direct Cloudflare deploys use `staged` by default: bwf checks the new Worker before sending it production traffic. If Cloudflare cannot stage an existing Durable Object Worker, choose `atomic` after reviewing the pending Worker and database changes:

```ts
// Inside defineConfig({ ... })
deploy: { cloudflare: { mode: 'atomic' } },
```

This choice applies to subsequent `bwf deploy` runs. Atomic deployment sends traffic to the new Worker before bwf checks readiness; a Durable Object class migration cannot be rolled back across its migration boundary. Use `--atomic` for a single deployment instead. `deploy` is a bwf setting and is not passed to Cloudflare's Worker config.

### `deploy.cloudflare.healthCheck` {#deploy-cloudflare-healthcheck}

A command to run once a deploy or a preview is ready. It checks what the app does, such as starting a record and reading it back, which the readiness check doesn't:

```ts
// Inside defineConfig({ ... })
deploy: { cloudflare: { healthCheck: 'node scripts/health.mjs' } },
```

The command runs in the project folder with the address in `BWF_DEPLOY_URL`, and without your Cloudflare credentials. It passes when it exits with 0. On `bwf deploy --platform cloudflare`, the new version is already live when it runs, so a failure fails the deploy and prints `bwf project rollback --platform cloudflare`. On a preview, a failure fails the command and prints the `--remove-preview` command. The check stops after three minutes. If the deploy has no workers.dev or preview address to give it, the deploy fails and says so, since a check that doesn't run would pass nothing.

### `routing`

Routing and edge configuration for headers, redirects, rewrites, and fallbacks.

#### `routing.alwaysUseHttps`

Redirect HTTP requests to HTTPS with a permanent `308` redirect. Omitted or `false` means off. Requires the Cloudflare target. `localhost` stays on HTTP. See [HTTP to HTTPS](../guide/edge/redirects#http-to-https) for where it works.

```ts
routing: {
  alwaysUseHttps: true,
}
```

#### `routing.typedRoutes`

Check URL strings against your app's routes in redirects, rewrites, and stream clients. This changes TypeScript checks only; navigation at runtime stays the same.

```ts
routing: {
  typedRoutes: true,
}
```

The default is `false`; `bwf init` enables it for new apps. See [Checked URL strings](../guide/type-safety#checked-url-strings) for accepted URLs and casts for values you validate at runtime.

#### `routing.headers`

Custom response headers. Keys are URL patterns, values are arrays of `"Name: value"` strings. See [Custom Headers](../guide/edge/headers) for details.

```json
{
  "routing": {
    "headers": {
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
    }
  }
}
```

#### `routing.redirects`

URL redirects. Keys are source URL patterns, values are destination strings (302 default) or objects with `to` and optional `status` (`301`, `302`, `303`, `307`, `308`). See [Redirects](../guide/edge/redirects) for details.

```json
{
  "routing": {
    "redirects": {
      "/old": "/new",
      "/blog/*": { "to": "/posts/:splat", "status": 301 }
    }
  }
}
```

#### `routing.rewrites`

URL rewrites. Keys are source URL patterns, values are destination paths. Serves content from the destination without changing the browser URL. See [Rewrites](../guide/edge/rewrites) for details.

```json
{
  "routing": {
    "rewrites": {
      "/": "/en",
      "/docs/*": "/en/docs/:splat"
    }
  }
}
```

Destinations use the `RewriteDestination` shape — typed route patterns plus `string`, so known routes autocomplete while dynamic paths remain accepted. See [Programmatic rewrites](../guide/edge/rewrites#programmatic-rewrites-in-middleware).

#### `routing.fallbacks`

Fallback rewrites. Same shape as `rewrites`, but rules only fire when no static asset or route matched the request (i.e. the request would otherwise 404). Useful for SPA shells or default-locale catch-alls that shouldn't pre-empt real routes. See [Rewrites → Fallbacks](../guide/edge/rewrites#fallbacks) for details.

```json
{
  "routing": {
    "fallbacks": {
      "/*": "/index.html"
    }
  }
}
```

#### `routing.notFound`

Override how the asset layer answers a request that matched no asset and no worker route. One of `"single-page-application"`, `"404-page"`, or `"none"`. If omitted, bwf infers it — see [Static Assets](../guide/edge/static-assets.md#navigation-and-middleware).

```json
{
  "routing": {
    "notFound": "404-page"
  }
}
```

Use `"404-page"` for a generated static site with a `404.html`, `"single-page-application"` for a client router, or `"none"` to keep the Worker's own 404. API and middleware routing remain unchanged.

### `inference`

Configuration for build-time inference, including how bwf detects your app type, bindings, and build process.

#### `inference.bindings`

Explicitly control inferred Cloudflare bindings. If omitted, bindings are [automatically inferred](./resource-inference.md) by scanning your source files for binding usage. Explicit values override the named bindings; omitted bindings are still inferred. Auth and checked-in migrations still require a database even when `db` is `false`.

Each binding accepts `true` (use default name), `false` (disable), or a string (custom binding name):

```json
{ "inference": { "bindings": { "db": true, "kv": false, "storage": "MY_BUCKET", "ai": "MY_AI" } } }
```

| Key       | Default Binding | Type          | Custom Name              |
| --------- | --------------- | ------------- | ------------------------ |
| `db`      | `DB`            | `D1Database`  | `"db": "MY_DB"`          |
| `kv`      | `KV`            | `KVNamespace` | `"kv": "MY_KV"`          |
| `storage` | `STORAGE`       | `R2Bucket`    | `"storage": "MY_BUCKET"` |
| `ai`      | `AI`            | `Ai`          | `"ai": "MY_AI"`          |
| `email`   | —               | —             | Boolean only             |

Custom binding names work with `@builtbyfriends/bwf/db`, `@builtbyfriends/bwf/kv`, and `@builtbyfriends/bwf/storage` during development and deployment. Custom AI names also work with `@builtbyfriends/bwf/ai` on direct Cloudflare deploys; managed Workers AI uses the platform's proxy.

`email` is a boolean feature switch. Set it to `true` to enable [email](../guide/email.md) and the local email inbox without an import from `@builtbyfriends/bwf/email`, or `false` to disable them. On a bwf platform, sending uses the platform proxy. Direct Cloudflare setup records a `SEND_EMAIL` binding in `bwf.lock.json`; see [`email.from`](#email).

#### `inference.build`

Override the build command. Useful for static apps with custom build scripts. If omitted, the CLI uses the detected default build command for the current app type. It applies to every app type, including `"platform"` (where the default is `vite build`).

```json
{ "inference": { "build": "vitepress build" } }
```

The command is run through a shell from the project root, with the project's own `node_modules/.bin` on `PATH`, so bare binaries and `&&` chains work:

```json
{ "inference": { "build": "vitepress build && vite build" } }
```

That chain is how a static site generator and a bwf backend ship together — see [Adding a backend to a static site](../guide/app-types.md#adding-a-backend-to-a-static-site).

#### `inference.scanDirs`

Override which directories are scanned for [binding inference](./resource-inference.md). Paths are relative to the project root. Replaces the default directories for the current mode.

```json
{ "inference": { "scanDirs": ["src", "lib", "workers"] } }
```

#### `inference.appType`

App type. If omitted, auto-detected on first deploy. See [Supported App Types](../guide/app-types.md).

- `"platform"`: React SPA assets plus a Worker for API routes, middleware, and jobs
- `"static"`: fully rendered HTML files from VitePress, plain HTML, or external tools. Non-matching paths return `404.html` or a 404 response.
- `"spa"`: static output with SPA fallback. Non-file paths fall back to `index.html` with a `200` status so client-side routing works out of the box.

#### `inference.outputDir`

Output directory for static deploys, relative to the project root. Only relevant when `inference.appType` is `"spa"` or `"static"`. Defaults to `"dist"`, or `"dist/client"` when the project depends on `@builtbyfriends/bwf`, because `bwfPlugin()` writes browser files there and server files to `dist/ssr`.
