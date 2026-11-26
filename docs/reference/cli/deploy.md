---
description: 'Build an app, provision its resources, apply migrations, and publish it.'
outline: deep
---

# Deployment {#deploy}

## `bwf deploy` {#platform-deploy}

```
bwf deploy [--project <name>] [--dir <path>] [--spa] [--skip-build] [--skip-migrations] [--debug]
bwf deploy [--platform <cloudflare|void>] [--require-email]
bwf deploy --platform cloudflare --atomic
bwf deploy --platform cloudflare --provision
bwf deploy --platform cloudflare --preview <name>
bwf deploy --platform cloudflare --remove-preview <name>
```

Auto-detects your project type and chooses the right pipeline. See [Supported App Types](../../guide/app-types.md) and [Deployment](../../guide/deployment.md) for details.

Deploying to a bwf platform requires an explicit connection with `bwf connect <url>`.
A saved project URL or `BWF_API_URL` alone does not establish a connection.
In fresh CI environments, run `bwf connect "$BWF_API_URL" --no-login` first.

On a bwf platform, an accepted deployment continues if the CLI disconnects. The CLI automatically reconnects to its progress. Pressing Ctrl+C stops observation; use `bwf project cancel` to request cancellation and `bwf project status` to inspect the result. If interrupted execution requires recovery, wait for its result before deploying again.

The CLI reports stalled progress and automatic recovery, and waits up to 30 minutes after acceptance. If it times out, the deployment can continue; check `bwf project status` before trying another deployment.

For an existing bwf Worker, `bwf deploy` can link the Worker and migrate its root Cloudflare config. Keep the first deployment focused on the existing app. See [Deploy an existing Worker](../../integrations/cloudflare.md#deploy-an-existing-worker) for requirements.

For Drizzle projects, deploy performs a read-only schema drift check. If a new migration would be generated, deploy stops and tells you to run `bwf db generate`, review the migration, commit it yourself, and rerun `bwf deploy`.

| Flag                            | Purpose                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--platform <cloudflare\|void>` | Override the platform stored in `.bwf/project.json`                                                                                  |
| `--project <name>`              | Target a specific bwf project by slug; not supported with `--platform cloudflare`                                                    |
| `--dir <path>`                  | Deploy a pre-built static directory (skips build)                                                                                    |
| `--spa`                         | Use SPA mode instead of SSG for static deploys                                                                                       |
| `--skip-build`                  | Skip the build step; on Cloudflare this is supported for static/SPA/SSG deploys only                                                 |
| `--skip-migrations`             | Deploy without applying application or authentication SQL migrations; supported on Cloudflare and bwf platforms                      |
| `--require-email`               | Fail when email cannot be set up instead of deploying without it; requires `--platform cloudflare`                                   |
| `--provision`                   | Run resource provisioning again even when every resource exists; requires `--platform cloudflare`                                    |
| `--atomic`                      | Publish an existing Durable Object Worker directly; readiness is checked after traffic changes                                       |
| `--preview <name>`              | Deploy a Worker Preview with its own Durable Objects and D1 databases; requires `--platform cloudflare`                              |
| `--secrets-file <file>`         | A dotenv file with the values of the deployed app's secrets, for `--preview`; environment variables of the same names are used first |
| `--remove-preview <name>`       | Delete a Worker Preview and the D1 databases made for it; requires `--platform cloudflare`                                           |
| `--debug`                       | Mirror the structured deploy log to stderr (also written to `~/.bwf/logs/`)                                                          |

`--atomic` applies to one deployment. For an existing Durable Object Worker that consistently cannot stage, set `deploy: { cloudflare: { mode: 'atomic' } }` in `bwf.config.ts` so plain `bwf deploy` uses atomic publication. The default is `staged`.

### Previews

`bwf deploy --platform cloudflare --preview pr-12` builds the app and deploys it as a [Cloudflare Worker Preview](https://developers.cloudflare.com/workers/previews/) named `pr-12`, then prints its address. The Worker needs a first deploy before it can have previews. The name is lowercase letters, digits and hyphens, up to 32 characters.

A preview gets its own copy of two things, and shares the rest with the deployed app:

- **Durable Objects.** Cloudflare gives a preview its own namespace for the Worker's own Durable Object classes. Objects you reach with `get()` and `getById()` from `defineDurableObject` and `defineDurableState` use it. A preview has no `c.env` binding to the Worker's own Durable Object classes. Code that reads one from `c.env` fails in a preview instead of reaching the deployed app's data, so use `get()` and `getById()`, or `ctx.exports`.
- **D1.** Each D1 database the app binds gets a copy named `<database>-preview-<name>`, such as `app-index-preview-pr-12`. bwf stops if that name is also a database the app declares, so a preview never reuses, migrates or deletes a database of the app's own. bwf creates it, applies the migrations in the binding's `migrations_dir` (or `db/migrations` for the app's own database), and binds the preview to it. `--skip-migrations` leaves the copy as it is.
- **Workflows.** Cloudflare doesn't make a Workflow for a preview, so a preview has no `c.env` binding to a Workflow of the app's own. Code that reads one fails in a preview. Without that, an instance a preview starts would run in the deployed app's Workflow and show on the live address.
- **Secrets.** A preview starts without the deployed app's secrets, and Cloudflare never returns a secret's value. bwf lists the secrets the deployed app has and sets a copy of each on the preview, after the preview deploys and before the health check. It takes each value from an environment variable of the same name, or from the dotenv file `--secrets-file` names. If the deployed app has a secret and bwf has no value for it, the command stops before it builds anything, names the secret, and deploys nothing. The values are never written to a file, the log or the lock file. Every live secret goes to the preview for now, and there's no way to leave one out. If the app has no deployed Worker yet, the command says to run a first `bwf deploy` and stops. Deleting the preview deletes its secrets too.
- **Logs.** Cloudflare keeps no logs for a preview unless its observability setting is on. Before it deploys the preview, bwf makes the preview with invocation logs on (or turns them on for one that exists), so its first deployment has logs. You can read them in the Cloudflare dashboard under the Worker's Previews, or with `cf` log tools. Every preview gets logs, and there's no way to leave them out. If the preview already has logs on, bwf leaves its settings alone. If observability is on but logs are off, bwf turns logs on. If bwf can't turn them on, it warns and the deploy carries on. If the deploy fails after bwf made the preview, an empty preview stays on the account. Deploying the same name again reuses it, and `--remove-preview` deletes it.
- **Everything else is shared.** KV, R2, queues and containers are the deployed app's. A preview reads and writes the live data there, so don't point a preview at an app that holds real data in those unless you want that. `bwf deploy --preview` lists this each time it runs.
- **A new owner class.** A preview can add a Durable Object class the deployed Worker doesn't have yet. It reaches the class through `get()`, `getById()` or `ctx.exports`, and the preview deploys without `--atomic`.

Deploying the same name again updates the preview and reuses its D1 copies. `bwf deploy --platform cloudflare --remove-preview pr-12` deletes the preview and its D1 copies in the same command, so a closed pull request leaves nothing behind. Run it again for a preview that is already gone and it reports nothing to delete.

If `deploy.cloudflare.healthCheck` is set, bwf runs it against the preview. See [`deploy.cloudflare.healthCheck`](../config.md#deploy-cloudflare-healthcheck).

Use `--skip-migrations` when you run migrations separately or share a database with a preview. The code must work with the database's current schema. The next deploy without this flag applies pending migrations.

Keep migration files and schema validation in place. This option skips application and authentication SQL; Durable Object class migrations still run when publishing code. If a bwf platform doesn't support the flag, upgrade it first.

Every deploy writes a JSONL log to `~/.bwf/logs/`. Failures print the log path and relevant details. Use `--debug` or `BWF_DEPLOY_DEBUG=1` to mirror it to stderr.

Keep credentials out of build commands and register them as CI secrets so your CI provider can mask them in logs.

Platform resolution precedence:

1. `--platform <cloudflare|void>`
2. `platform` in `.bwf/project.json`
3. bwf for projects initialized by an older SDK without a saved platform

Selecting Skip deployment setup stores `"platform": "none"`; a later `bwf deploy` stops with guidance until a platform override is provided.

For the bwf platform, project resolution precedence is:

1. `--project <name>`
2. `BWF_PROJECT`
3. linked project in `.bwf/project.json`

If no project is linked and no override is provided, CLI prompts to link or create one. In CI (non-TTY), `bwf deploy` errors out instead — set `BWF_PROJECT` or pass `--project <slug>`.

To deploy to another connected bwf platform for one invocation:

```sh
bwf connect second.example.com
BWF_API_URL=https://second.example.com bwf deploy --platform void --project my-app
```

`BWF_API_URL` selects the platform and `--project` selects its project. You must
name the project when overriding a different platform's saved link. Existing
project links and deployment preferences remain unchanged, even when the target
project is created. The same applies to `BWF_PROJECT` and to another project on
the current platform. A first deployment still links the project when no destination
is configured. See [Deploy to another bwf platform](../../guide/deployment.md#deploy-to-another-platform).

## `bwf deploy --platform cloudflare` {#platform-deploy-platform-cloudflare}

Build and deploy to your Cloudflare account using `bwf.config.ts`:

```sh
bwf deploy --platform cloudflare
bwf deploy --platform cloudflare --require-email   # fail instead of deploying without email
```

bwf signs you in through your browser when needed and saves the selected account. In CI, set `CLOUDFLARE_API_TOKEN` and, if the token can access several accounts, `CLOUDFLARE_ACCOUNT_ID`.

| Option or setting              | Cloudflare behavior                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dir`, `--spa`               | Deploy static output through a small Worker and Workers Assets                                                                                |
| `--skip-build`                 | Reuse existing static, SPA, or SSG output; unavailable for Worker apps                                                                        |
| `--skip-migrations`            | Skip database migrations; existing PostgreSQL/MySQL Hyperdrive bindings do not require `DATABASE_URL` just to skip SQL                        |
| `--project`                    | Unavailable; the Worker and account come from `bwf.config.ts` and `bwf.lock.json`                                                             |
| Named environments             | Unavailable; use the top-level `cloudflare` config                                                                                            |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | Needed in fresh CI when a workers.dev Worker has no preview URL; cached locally after a deploy. It does not apply when `workers_dev` is false |
| `CF_ACCESS_READINESS_ORIGIN`   | Lets Access credentials reach the readiness check on a route or Custom Domain, for example `https://app.example.com`                          |
| `--require-email`              | Fail instead of deploying without email when the email step cannot run, as in CI                                                              |
| `DATABASE_URL`                 | Required in the deploy environment for PostgreSQL or MySQL provisioning and migrations                                                        |

After `--skip-migrations`, direct Cloudflare deployment history shows the applied migration state as unknown. Rolling back code doesn't reverse database changes.

When using an API token, grant **Workers Admin** to create the Worker or **Workers Editor** to update it. See [Cloudflare CI credentials](../../integrations/cloudflare.md#deploying-from-ci) for zone and resource permissions. Commit `bwf.lock.json` after the first deploy before using other machines or CI.

Use `bwf secret put <NAME>` for production server values. Local `.env` values are never deployed. Run `bwf db generate` and commit schema changes before deploying.

Sandbox requires [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans), Docker, and Containers access. API tokens need Account / Containers: Edit and Account / Cloudchamber: Edit.

For email, set `email.from` and run `bwf email setup --platform cloudflare` locally. Commit the lock file and pass `--require-email` in CI. See [Email setup](../../guide/email/domains.md#your-own-cloudflare-account).

For Access credentials, Hyperdrive permissions, readiness, and rollback, see [Cloudflare deployment](../../integrations/cloudflare.md#deploy-to-your-own-cloudflare-account).
