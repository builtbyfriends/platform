---
description: 'Deploy with void deploy. It builds your app, provisions resources, applies migrations, and publishes to Cloudflare or a team platform.'
outline: deep
---

# Deployment

`bwf deploy` builds your app, provisions resources, applies migrations, and deploys it. Choose your own Cloudflare account or a bwf platform run by your team.

After a successful deployment, bwf prints your deployment URL in a summary box with the details reported by your deployment target.

## Deploy to Cloudflare

Choose Cloudflare during `bwf init`, or connect later:

```sh
bwf connect --platform cloudflare
bwf deploy --platform cloudflare
```

bwf opens your browser to sign in and asks which account to use. Later deploys use the saved target, so you can run `bwf deploy`.

Native apps work on Workers Free within its quotas. [Sandboxes](./sandboxes.md#requirements) require Workers Paid and Containers access. See the [Cloudflare guide](../integrations/cloudflare.md) for configuration, token permissions, and features with additional requirements.

If you already have a Worker and a root `wrangler.jsonc` or `wrangler.json`, `bwf deploy` can link it and preserve its resources. See [Deploy an existing Worker](../integrations/cloudflare.md#deploy-an-existing-worker).

## Prepare your app

### Migrations

Deploy applies pending SQL migrations from `db/migrations/`. If your schema has changes without a migration, deploy stops:

```sh
bwf db generate
```

Review and commit the SQL, then deploy again. Rollback does not reverse database migrations. See [Database](./database.md) for the local workflow.

If you run migrations in a separate release step, or a preview shares your database, deploy without applying SQL migrations:

```sh
bwf deploy --skip-migrations
```

The app must work with the database's current schema. Both deployment destinations support this option, and the next deploy without it applies pending migrations. See [`--skip-migrations`](../reference/cli/deploy.md#platform-deploy) for requirements and [`bwf db migrate`](../reference/cli/database.md#platform-db-migrate) to apply migrations separately.

For D1 on your own Cloudflare account, deploy saves a restore point before applying migrations and prints a [`bwf db restore`](../reference/cli/database.md#platform-db-restore) command. Use it to recover from a bad migration, then fix the migration before deploying again. A restore discards writes made after that point; check that your deployed code works with the restored schema. See the command reference for the recovery steps and retention limits.

### Environment variables

Declare values in `env.ts` and set production server secrets with `bwf secret put`. Deploy never uploads your local `.env`. Supply public `VITE_*` values through the build environment. See [Environment Variables](./env-vars.md).

Keep the CLI and framework adapters on matching versions, and commit `bwf.config.ts` and `bwf.lock.json` when generated.

## Deploy from GitHub {#github}

Generate a workflow for your saved target and package manager:

```sh
bwf init --github
```

For Cloudflare, add `CLOUDFLARE_API_TOKEN` to your repository secrets. The token needs access to the account and products your app uses. PostgreSQL and MySQL apps also need `DATABASE_URL`.

Follow the [Cloudflare CI setup](../integrations/cloudflare.md#deploying-from-ci) for Worker preview URLs and Cloudflare Access credentials.

### Team platform CI

For a core self-hosted platform, use your own workflow with a [project deploy token](./platform/installation/first-deployment.md). Set `BWF_TOKEN`, `BWF_API_URL`, and the project slug, then connect in each fresh CI environment:

```sh
bwf connect "$BWF_API_URL" --no-login
bwf deploy --platform void --project "$BWF_PROJECT"
```

Platforms with the optional GitHub Actions integration use short-lived OIDC credentials. Authorize the repository with `bwf github connect <project> --repo <owner/repo> --executor github_actions`, set the repository's `BWF_API_URL`, and keep `permissions: id-token: write` in the generated workflow.

If your platform supports managed GitHub builds, the GitHub App can deploy on push without a workflow file. See [GitHub commands](../reference/cli/github.md#github) to install the App and connect your repository.

If CI runs typechecking before deploy, run `bwf prepare` after installing dependencies to generate the `.bwf/` types.

## Previews for pull requests {#previews}

On Cloudflare, give each pull request its own copy of the app. A preview has its own Durable Objects and its own D1 databases. A preview has no binding to a Workflow, and it gets its own copy of the deployed app's secrets. KV, R2, queues and containers are still the deployed app's, so a preview can change live data there:

```sh
bwf deploy --platform cloudflare --preview pr-12
bwf deploy --platform cloudflare --remove-preview pr-12
```

The first command prints the preview's address. The second deletes the preview and its D1 copies, so run it when the pull request closes. To check what the app does, not only that it starts, set [`deploy.cloudflare.healthCheck`](../reference/config.md#deploy-cloudflare-healthcheck). See [Previews](../reference/cli/deploy.md#previews) for what a preview shares with the deployed app.

A preview needs a value for each secret the deployed app has, and Cloudflare never returns those. In a CI workflow, make every secret the deployed app holds available to the preview step as an environment variable of the same name, or write them to a dotenv file and pass `--secrets-file <file>`. Run `bwf secret list` to see the names. If one is missing, the preview step fails before it deploys anything and names it. A pull request from a fork usually can't read repository secrets, so a preview of it can't run.

## Deploy to a team platform

Use the API URL from your administrator. In a new or unlinked app:

```sh
bwf connect platform.example.com
bwf deploy --platform void --project my-app
```

Sign in and confirm project creation when asked. To use an existing project, run `bwf project link`. Later deploys use the saved destination.

Project owners can [share access](./project-collaboration.md). To install a platform for your team, start with [Install a bwf Platform](./self-hosted-platform.md), which also compares the deployment features of both targets.

### Deploy to another bwf platform

For a single deployment to a different platform, connect and name its project:

```sh
bwf connect second.example.com
BWF_API_URL=https://second.example.com bwf deploy --platform void --project my-app
```

This keeps your saved destination. Each platform has its own projects, secrets, and data. See the [CLI reference](../reference/cli/deploy.md) for target selection and other flags.

## Logs and rollback

Inspect your deployment, read runtime logs, or select a previous deployment:

```sh
bwf project status
bwf project logs
bwf project rollback
```

Cloudflare logs use a live tail; team platforms retain log history. Before rolling back, check that the earlier code works with your current database schema. On Cloudflare, a rollback can't go back past a deploy that added a Durable Object class (Cloudflare error 100402); fix forward from there. See [Project commands](../reference/cli/project.md).

## Usage and execution limit pages

Team platforms return a structured HTTP 429 to API and Pages action requests when an app exceeds its request or CPU allowance. Browser requests get an error page.

To customize it, add `public/usage-limit.html` for request limits or `public/execution-limit.html` for execution limits. Use standalone HTML with inline CSS and data-URL images. Scripts, external assets, and form submissions are disabled. Missing custom pages use the built-in page.

Responses are not cached. A streaming response that has already started cannot be replaced with an error page; handle stream failures in your UI.

## Try a bwf change before it releases {#snapshots}

A bwf release takes a pull request, a round of checks and a publish. To try a change in your app before then, use a snapshot. Each pull request in the bwf repository that changes `packages/` publishes one in about a minute, and the pull request gets a comment with the version. It looks like this:

```text
1.13.9-snap.133.ga1b2c3d
```

The first part is the release the pull request will become, `snap` marks it as a snapshot, `133` is the pull request, and `g` followed by seven characters is the commit. Every bwf package in the repository gets the same version, and it's published under the `snapshot` tag.

In a branch of your app, pin that exact version, install, and deploy the branch's preview:

```sh
npm install --save-exact @builtbyfriends/bwf@1.13.9-snap.133.ga1b2c3d
bwf deploy --platform cloudflare --preview pr-12
```

Use the exact version, not the `snapshot` tag. A new commit on the pull request publishes a new snapshot, so move the pin when you want it. A range such as `^1.13.8` never picks a snapshot up.

Before the branch merges, move the pin back to a release. A snapshot is for trying a change, and it's removed 30 days after it's published. To publish a snapshot of a branch with no pull request, run the Snapshot workflow by hand and give it a short label.
