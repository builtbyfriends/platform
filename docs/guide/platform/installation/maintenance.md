---
description: 'Resume, repair, upgrade, or recover an installation, including when the keychain or API is unavailable.'
outline: deep
---

# Maintenance and Recovery

## Resume, repair, recover, and upgrade

Run `bwf platform list` to find the installation slug beside its name. Lifecycle commands accept this slug, an installation ID, or a saved connection ID. You can omit the selector when only one installation is configured. With several installations, choose one interactively or pass its slug or ID in CI.

### Resume an installation

If setup stops or fails, continue from the saved progress:

```sh
bwf platform install --resume --name <id>
```

You can correct the database URL if the initial connection failed. Once bwf has claimed the database or provisioned Hyperdrive, that database is fixed for the installation. A later command with a different URL stops before making changes.

### Cloudflare Access blocks the health check {#cloudflare-access}

If installation reports **Default-Deny (error 1050)**, Cloudflare blocked the HTTP health check before it reached bwf. This is separate from the API token used to deploy the Workers.

Keep the company protection in place. Automatic Access setup saves its scoped
service credentials with the installation's encrypted recovery material. For an
existing gate, verify that its service policy admits the installation token and
that the application covers the printed API and proxy origins. A Cloudflare
management API token does not authenticate an Access-protected HTTP request.

For automatic setup, resuming also creates or verifies an Access exception
limited to `/health` on the reserved dispatch health hostname. bwf still requires
its private probe token on that endpoint; requests without it cannot reach an
application. This lets installation check routing while employee protection and
account-wide Default-Deny remain enabled. It does not bypass Access for an entire
Worker or for deployed apps.

For externally supplied credentials, set `PLATFORM_ACCESS_CREDENTIALS` from your
secret manager to an object keyed by each exact API/proxy origin, with
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in each entry. Then rerun
`bwf platform install --resume --name <id>`. bwf retains the saved resources
and stops if the gate still rejects its checks. Account-wide Default-Deny and
deployed-application policies remain your responsibility.

### Expired administrator setup code

Resume an unfinished installation with `bwf platform install --resume --name <id>`.
For completed provisioning whose administrator setup is still pending, run
`bwf platform repair <id>`. bwf prints a fresh setup code if the earlier code
expired. Enter it at `/setup`, sign in, and confirm the displayed identity.
An installation that already has an administrator does not reopen setup.

### First administrator sign-in fails

If sign-in fails after you enter the setup code, the page shows the reason and an
error code. When a provider setting may be the cause, it also shows the callback
URL the provider must have.

| Error code                                                                  | What to check                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `github_incorrect_client_credentials`, `github_failed`, `oidc_token_failed` | The client ID and client secret, and that the provider has the callback URL |
| `github_redirect_uri_mismatch`                                              | The callback URL registered in the GitHub OAuth app                         |
| `oidc_discovery_failed`                                                     | The issuer URL, exactly, including any trailing slash                       |
| `github_unverified_user_email`                                              | Verify the primary email of the GitHub account                              |
| `google_domain_not_allowed`, `oidc_group_not_allowed`                       | Sign in with an allowed account, or change the allowed domains or groups    |
| `login_denied`, `github_bad_verification_code`                              | Start a new sign-in                                                         |

If the provider shows its own error page instead, register exactly the callback
URL printed with your setup code.

To change the login settings, run repair on the computer that installed the
platform:

```sh
bwf platform repair <id>
bwf platform repair <id> --auth-config <path>
```

Interactive repair asks whether to change the login settings, with the saved
values filled in; leave the client secret blank to keep it. `--auth-config`
takes a file in the [install format](/guide/platform/installation/setup#finish-login-configuration)
and is the way to change OIDC allowed groups. Login methods and Access protection
stay as installed. Repair prints a new setup code and the callback URL.

A GitHub-only installation signs in with the GitHub OAuth App from its
installation settings. To replace its client ID and secret, set
`PLATFORM_GITHUB_CLIENT_ID` and `PLATFORM_GITHUB_CLIENT_SECRET` when
you run `bwf platform repair <id>`.

### Repair missing resources

Preview what needs repair, then apply it:

```sh
bwf platform repair [id] --plan
bwf platform repair [id]
```

Repair recreates missing infrastructure that the installer owns. It does not restore PostgreSQL rows or data stored in provider resources. If an adopted or external resource is missing, restore it yourself before continuing. A disabled platform stays disabled through repair and upgrade.

### Upgrade the platform

Upgrade the platform before your team updates its CLI. Install the new CLI on the administrator's machine, run the upgrade below, then have the team update.

For apps using `@builtbyfriends/bwf/sandbox`, add **Account → Containers → Edit** and **Account → Cloudchamber → Edit** to the runtime token. Edit its permissions in Cloudflare, or supply a replacement with `PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN`. See [Cloudflare API Tokens](/guide/platform/installation/credentials#runtime-token-permissions).

Use the installed CLI's packaged runtime to upgrade:

```sh
bwf platform upgrade [id] --plan
bwf platform upgrade [id]
```

An upgrade validates the runtime, applies supported pending migrations, deploys the Workers, and checks their health. Existing Worker secrets are preserved.

Install, upgrade, and repair also publish the saved [AI Gateway logging](/reference/cli/platform-users#ai-gateway-logging) settings (**Publishing AI logging settings**). For about 2 minutes afterward, `bwf platform project show` reports projects with a setting other than `inherit` as `pending`, as well as projects it switched back to `inherit`.

Before starting, bwf checks access to the installation's Cloudflare account, Workers, and existing R2 buckets. It lists every missing permission at once and names the credential Cloudflare rejected. If the management credential is rejected, set `CLOUDFLARE_API_TOKEN` to a management token scoped to that account and retry. This overrides the installation's saved management token.

With browser login, bwf uses the runtime token for AI Gateway: `PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN`, or the one saved on this machine. If an error names the runtime token, set `PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` to a valid runtime token, or set `CLOUDFLARE_API_TOKEN` to a management token with **Account → AI Gateway → Edit**. bwf then uses that token instead of browser login.

Some upgrades pause application traffic until the new version passes health checks. If a command fails while traffic is paused:

1. Run `bwf platform status <id>` to see the saved progress.
2. Fix the reported problem.
3. Run the printed resume command with the same runtime. Traffic resumes when it succeeds.

::: details Migration safety, credential rotation, and rollback

To update the runtime Cloudflare token, GitHub OAuth credentials when GitHub login is enabled, or R2 credentials,
provide their `PLATFORM_*` environment variables when running `upgrade` or `repair`.
Only the supplied values replace live credentials. Recovery data from an older
workstation does not overwrite them, and upgrades preserve the live signing keys
and complete project-encryption keyring. Keep current credentials in your secret
manager so they can also restore a missing Worker during repair.

Set `PLATFORM_R2_ACCESS_KEY_ID` and `PLATFORM_R2_SECRET_ACCESS_KEY` together, even if
only the secret changed. bwf checks the R2 pair against the assets bucket before it changes the
platform.

Database migrations only move forward. bwf checks compatibility before upgrading and tells you if an intermediate release is needed. If deployment fails, it attempts to restore the previous Workers against the compatible database schema. Retrying does not repeat completed migrations.

After a successful upgrade, you can restore a declared-compatible earlier runtime without reversing migrations:

```sh
bwf platform rollback [id] --runtime /path/to/earlier/runtime --plan
bwf platform rollback [id] --runtime /path/to/earlier/runtime
```

Keep the earlier runtime files if you need rollback. If the installed version is a custom build, also pass its files with `--from-runtime /path/to/current/runtime`. bwf checks that the earlier version can run against your current database and refuses incompatible rollbacks. A later `upgrade` can move forward again. See [Platform Development](/guide/platform/development/runtime#deploying-your-runtime) for working with custom builds.

Do not roll back to 0.26.0 or earlier after upgrading to a later release. bwf does not refuse this rollback, but those releases reject the credentials that later releases give your apps. Every project deployed or rotated since the upgrade loses AI, email, and remote D1, KV, and R2 until you upgrade again. If you have rolled back that far, upgrade again, then run `bwf platform system rotate-proxy-tokens --all --yes` and check with `--plan` until nothing is pending or failed.

After a rollback to 1.8.0, plan [AI Gateway logging](/guide/platform/administration/plans#ai-gateway-logging) defaults are not applied: projects that follow a plan default use the gateway's own setting, which logs prompts and responses on a new installation. Project settings still apply. Plan defaults stay saved, and the next upgrade publishes them again. A rollback to a release before 1.8.0 applies no AI logging settings.

Let running rotations finish before you roll back. If an older proxy runs next to a newer API, remote D1, KV, and R2 fail until both run the same release. After a rollback to the release just before credential rotation, projects deployed since the upgrade lose remote D1, KV, and R2 until they are deployed again or you upgrade again. A rotated project deployed during any rollback stays broken after you upgrade again, and 0.26.0 and earlier also drop rotations that have not finished. After upgrading again from any rollback, run the same `rotate-proxy-tokens` commands.

:::

### Change runtime logs {#runtime-logs}

Switch an installed platform between [full and minimal runtime logs](/guide/platform/installation/setup#runtime-logs) with an upgrade:

```sh
bwf platform upgrade [id] --runtime-logs minimal
bwf platform upgrade [id] --runtime-logs full
```

The setting also applies to existing project deployments, and later upgrades keep it. Previously stored logs remain until Cloudflare's retention period ends.

If updating project logs fails, the platform upgrade still completes and prints a recovery command. Run `bwf platform repair [id]` after switching to minimal, or repeat the upgrade after switching to full.

While runtime logs are minimal, `bwf platform rollback` refuses a runtime that does not support the setting. Run `bwf platform upgrade [id] --runtime-logs full` first.

### Platform Workers changed outside bwf {#workers-changed-outside-platform}

Use bwf commands to manage the platform's Workers. If their configuration was changed in Cloudflare, or bwf cannot identify the active version, maintenance asks you to approve replacing it. Preview the affected Workers with `--plan`.

Run the printed command in a terminal and review **Replace the configuration of these Workers?** The default is No. Accepting restores bwf's configuration, including removing manually added variables. You may see another confirmation with the configuration differences before deployment. Declining that later prompt leaves any resource and database preparation in place.

CI and `--yes` runs stop when this approval is needed. Complete the interactive command once, then resume automation. If a Worker uses a gradual deployment, first select one version for 100% of traffic in Cloudflare.

If traffic was already paused by an earlier failed run, follow [Upgrade the platform](#upgrade-the-platform) to resume it.

### Follow upgrade and rollback progress

Watching progress is optional: a running upgrade or rollback proceeds through
the CLI without action on the status page. During maintenance, navigating the
admin UI automatically redirects to `/admin/status`. You can also open it
directly on your platform API origin and sign in as an administrator.

The read-only page shows the saved operation, source and target versions, and
the traffic state reported by the API. It refreshes automatically every five
seconds while visible. If updates fail, it keeps the last confirmed snapshot
and marks it as out of date. Normal administrator changes remain paused.

Sign-in and status remain available while the API and authentication database
are reachable. An operation completing
does not confirm every project's health. A disabled installation keeps traffic
paused after an upgrade or rollback.

If an operation fails or waits for DNS or Sandbox drain work, the CLI prints
the recovery instructions and command needed to resume. Resolve the reported
problem, then resume with the same runtime files. For a custom rollback, retain
the source runtime files too. `bwf platform status <id>` also prints locally saved progress
before checking the live API; this local checkpoint can be out of date if another
administrator changed the installation.

When application traffic is paused, visitors receive a temporary-unavailability
page with a **Try again** link. API requests and form submissions still receive
HTTP 503 responses. bwf does not automatically replay requests; visitors who
submitted a form should check its result before submitting it again.

### Manage an installation from another machine

Use `discover` to restore the administrator's local installation records:

```sh
bwf platform discover --account <account-id> --installation <id-or-name>
```

Discovery restores local installation records after verifying the resources belong to your platform. It also works for interrupted or disabled installations. If infrastructure is missing, run `bwf platform repair [id]` after discovery. If ownership cannot be verified, the command stops without changing resources.

After discovery, provide `PLATFORM_DATABASE_URL` for migrations and to coordinate administrator commands. You don't need to re-enter the other secrets for an upgrade that preserves every deployed Worker. For an email-enabled installation without its encrypted recovery file, restore `PLATFORM_EMAIL_SIGNING_SECRET`; recreating only the email gateway needs that key and no Cloudflare runtime token or JWT signing key. Recreating the API or proxy also requires the email key when email is enabled, in addition to their normal secrets. Recreating the API requires its original runtime token (`PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN`), R2, JWT, and project-encryption values through the `PLATFORM_*` variables; a GitHub-only installation also needs its original GitHub OAuth values. Recreating the proxy requires the runtime token and JWT signing key. Cloudflare can't return these values, so keep them in your organization's secret manager.

If you have not rotated the project-encryption key, restore it with `PLATFORM_PROJECT_SECRET_KEY`. After rotation, supply `PLATFORM_PROJECT_SECRET_KEYS_JSON` with all retained keys and `PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION` with the active key's name. Keep older keys needed to decrypt existing project secrets. These values are used to recreate a missing API Worker; they do not replace the live keys during an ordinary upgrade. Supply them from your secret manager.

### Prepare for disaster recovery

`discover` reconstructs verified installation metadata on another machine. It does not download credentials, key material, or backed-up data. `repair` can then recreate missing installer-owned infrastructure, but it does not recover the data that infrastructure previously held.

Keep a coordinated recovery set for each installation:

- a PostgreSQL backup;
- the installation identity—the JWT signing secret, the email signing secret when email is enabled, and the complete project-encryption keyring—in a secret manager;
- provider-supported backups or exports for every data-bearing provider resource;
- the immutable runtime artifacts and manifest for the installed version or custom source revision.

Capture and label these items as one recovery point so PostgreSQL, provider data, identity, and encryption keys match. Backup and retention capabilities vary by provider and resource; choose and test the supported recovery process for each resource you use.

During a restore, keep platform and application traffic disabled before changing resources. Restore the matching PostgreSQL and provider data with their supported recovery tools, supply the original identity and keyring, and use the preserved runtime artifact. Then run `discover`, preview `repair` with `--plan`, and review every ownership decision and proposed resource change before applying it. Enable traffic only after the restored data and platform health have been verified. Discovery and repair are not substitutes for those backups and do not provide a recovery bypass when required secrets or data are unavailable.

### Back up and restore {#back-up-and-restore}

A recovery plan you haven't tried tends to fail on the day you need it. Set up scheduled backups, then restore one into a test installation and time it.

#### Scheduled backups

- **PostgreSQL.** Turn on your database provider's scheduled backups or point-in-time restore, and set how long it keeps them. Also take a nightly `pg_dump --format=custom` to storage in a different account or provider, so a problem with the database provider doesn't take the backups with it. The [workflow below](#nightly-database-backup) does this from GitHub Actions.
- **Identity and keys.** Keep the JWT signing secret, the email signing secret and the project-encryption keyring in your secret manager. They change only when you rotate them, so save them again after each rotation.
- **Runtime.** Keep the runtime files for each version you install. `bwf platform list --health` shows which version each installation runs.
- **App data.** Each app's D1 databases have Cloudflare's Time Travel, which can restore to any minute in the last 30 days on Workers Paid. For longer, export them on a schedule with `wrangler d1 export`. R2 buckets and KV namespaces have no built-in backups; copy what you can't rebuild.

Keep backups as long as your contracts say. 35 days of nightly backups is a common starting point. An R2 lifecycle rule can delete older ones for you.

#### Nightly database backup {#nightly-database-backup}

This GitHub Actions workflow dumps the database each night and uploads it to an R2 bucket. Create the bucket in a different Cloudflare account from the installation, with an R2 API token that can only write to it. Add a lifecycle rule to the bucket to delete objects after your retention period.

```yaml
name: Platform database backup
on:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:
permissions: {}
jobs:
  backup:
    runs-on: ubuntu-latest
    environment: backup
    steps:
      - name: Dump and upload
        env:
          DATABASE_URL: ${{ secrets.PLATFORM_DATABASE_URL }}
          AWS_ACCESS_KEY_ID: ${{ secrets.BACKUP_R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.BACKUP_R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          ENDPOINT: https://${{ vars.BACKUP_R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
          BUCKET: ${{ vars.BACKUP_R2_BUCKET }}
        run: |
          set -euo pipefail
          name="platform-$(date -u +%Y-%m-%dT%H%M%SZ).dump"
          docker run --rm -e DATABASE_URL -v "$PWD:/out" postgres:17 \
            sh -c 'pg_dump --format=custom --no-owner --file="/out/$0" "$DATABASE_URL"' "$name"
          aws s3 cp "$name" "s3://$BUCKET/$name" --endpoint-url "$ENDPOINT"
```

Give the workflow a read-only database role, since a dump only reads. Use a `postgres` image whose major version is the same as or newer than your database server's.

#### Restore drill

Run the drill on a test installation, not the one your apps use. Keep a test installation that matches the main one's version and settings, with a small app deployed on it. Write down the time at each step.

1. **Back up.** Take a backup of the test installation the same way you back up the main one, or use last night's.
2. **Stop traffic.** Run `bwf platform disable <test>`.
3. **Restore the database in place.** An installation stays tied to its database address, so restore into the same database: `pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" <file>.dump`, or your provider's point-in-time restore to that address.
4. **Restore app data.** Restore the test app's D1 database with `wrangler d1 time-travel restore`, or import its export.
5. **Rebuild the machine side.** On a machine without the installation's records, run `bwf platform discover`, then `bwf platform repair <test> --plan` and `bwf platform repair <test>` with the `PLATFORM_*` values from your secret manager. Use the same runtime version.
6. **Turn it on and check it.** Run `bwf platform enable <test>`, then `bwf platform list --health` and `bwf platform system health`. Open the test app and check that its data is back. Sign in to the dashboard.
7. **Write it down.** Note the date, the backup used, how long each step took, the total time, and anything that didn't go as written. Fix this page where it was wrong.

Repeat the drill every three months, and after a release that changes how data is stored. The total time is the least you can promise for recovery.

### Where local state lives

Installation records live in `~/.bwf/platforms/`. Credentials are stored separately in encrypted recovery files, with the encryption key in your operating system's keychain. Keep your original secrets in a password manager for recovery on another machine. Signing and encryption keys that bwf generated exist only in these files; to keep your own copy, [supply them when installing](/guide/platform/installation/credentials#signing-and-encryption-keys).

If the keychain isn't available, bwf stops before writing secrets. Headless environments can supply `PLATFORM_RECOVERY_KEY`: a canonical base64-encoded 32-byte key from a secret manager. A temporary CI runner can use a new recovery-encryption key for each run only when every original credential remains available in protected CI secrets, including `PLATFORM_JWT_SECRET`, `PLATFORM_EMAIL_SIGNING_SECRET` for an email-enabled installation, and either the original `PLATFORM_PROJECT_SECRET_KEY` or the complete rotated keyring and active-version pair.

::: details Ownership and interrupted maintenance

bwf checks resource ownership and the configured database before making changes. Concurrent maintenance commands are coordinated so one administrator cannot overwrite another's work.

If maintenance is interrupted, rerun the same command. Traffic may stay paused until verification succeeds. Existing routes, domains, and data are preserved.

:::
