---
description: 'Stand up another installation, see every installation with its version and health, and upgrade several in one command.'
outline: deep
---

# Run Several Installations

Some teams run more than one platform: a test installation next to the main one, or a separate installation for a customer whose apps and data must stay apart. bwf keeps a record of each installation on the machine that installed it, so you can check and upgrade them all from there.

## Stand up a new installation

This checklist goes from an empty Cloudflare account to a first deployed app. Each step links to the page with the details.

1. **Pick the account.** Use a separate Cloudflare account for each installation. Each one then has its own billing, limits and access, and an upgrade of one can't touch another's resources. Add the people who run installations to the account with permission to create API tokens.
2. **Prepare the account and domain.** Turn on Workers for Platforms, R2 and Analytics Engine, and add the app domain. See [Prerequisites](./prerequisites.md).
3. **Make a database.** Create an empty PostgreSQL database for this installation only. Two installations can't share one.
4. **Make the credentials.** Create the management and runtime tokens scoped to this account, and the login provider's app. Save them, the database URL and any keys you supply in your secret manager under the installation's name. See [Credentials](./credentials.md).
5. **Install.** Give the installation a slug you'll recognize, such as `acme`. Preview with `--plan`, then install. See [Install and Configure Login](./setup.md).
6. **Sign in and check it.** Finish administrator setup, then run `bwf platform status acme` and `bwf platform list --health`.
7. **Deploy a first app.** Connect to the new API address from a fresh app directory and deploy. See [First Deployment](./first-deployment.md).
8. **Set up backups.** Follow [Prepare for disaster recovery](./maintenance.md#prepare-for-disaster-recovery) and [Back up and restore](./maintenance.md#back-up-and-restore) before real apps move in.

Apps find an installation by its API address. A person runs `bwf connect <api-address>`, and CI sets `BWF_API_URL`. bwf then reads the installation's details from `<api-address>/.well-known/platform`.

## See every installation

```sh
bwf platform list --health
```

Each entry shows the account and state bwf recorded, the version it recorded at the last install or upgrade, and the version and health the installation reports now. Health comes from the API's `/health` address, which checks that the API can reach its database. A platform you connected to but didn't install from this machine shows as connected only. Upgrades leave it alone.

To manage an installation from a second machine, restore its records with [`bwf platform discover`](./maintenance.md#manage-an-installation-from-another-machine).

## Upgrade several installations

Name the installations in the order you want them upgraded. Put a test installation first:

```sh
bwf platform upgrade acme-test acme --plan
bwf platform upgrade acme-test acme
```

bwf upgrades one installation at a time. After each upgrade it checks the installation's `/health` address and prints its version. If an upgrade or its health check fails, bwf stops there and names the installations it upgraded and the ones it didn't start. Fix the problem, then run the command again with the installations that are left.

Installations you don't name aren't changed. Each upgrade uses the credentials saved for that installation, so unset `CLOUDFLARE_API_TOKEN` and any `PLATFORM_*` values for one installation before you upgrade several. To change an installation's credentials, upgrade it on its own with those values set.

An upgrade that brings database migrations runs them for each installation in turn. bwf already stops a second administrator from changing the same installation at the same time.
