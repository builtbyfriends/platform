---
description: 'List, set, and remove production secrets. Secret values are never printed.'
outline: deep
---

# Secrets and Environment {#secrets}

## `bwf secret list` {#platform-secret-list}

```
bwf secret list [--project <name>] [--preview]
```

List production secret names for the saved target. Secret values are never printed. Direct Cloudflare targets query the Worker named in `bwf.config.ts`; `--project` is hosted-only.

`--preview` works on a direct Cloudflare target. It lists or changes the secrets in the Worker's preview Base instead of the live Worker, and takes no `--project`. Cloudflare copies the Base into each new [preview](./deploy.md#previews). A preview that exists keeps the secrets it had.

## `bwf secret put` {#platform-secret-put}

```
bwf secret put <name> [--project <name>] [--preview]
bwf secret put <name=value> [--project <name>] [--preview]
```

Value input modes:

- inline: `bwf secret put API_KEY=abcd`
- prompt (TTY): `bwf secret put API_KEY` (masked input)
- stdin: `echo -n "abcd" | bwf secret put API_KEY`

On a direct Cloudflare target, the value is stored as an encrypted Worker secret.

## `bwf secret sync` {#platform-secret-sync}

```
bwf secret sync <file> [--project <name>] [--yes] [--preview]
```

Upload production server values from a dotenv file stored outside your project. Include only keys declared in `env.ts`; leave out local development credentials and public `VITE_*` values.

```sh
bwf secret sync /secure/path/production.env
```

Pass `--yes` to skip confirmation in scripts and CI.

Existing remote secrets absent from the file are kept. Every entry must be a server key declared in `env.ts`, and its value must pass validation.

## `bwf secret delete` {#platform-secret-delete}

```
bwf secret delete <name> [--project <name>] [--preview]
```

Secret commands use the platform saved in `.bwf/project.json`. Hosted project resolution follows the same order as deploy (`--project`, env var, linked project). Direct Cloudflare targets reject `--project` and use the pinned root Cloudflare config.

On hosted projects, secret writes and deletes return a retryable conflict while a deployment or rollback is in progress. Wait for that operation to finish and retry; the rejected operation leaves the stored secret unchanged.

## Env Schema {#env-schema}

### `bwf env check` {#platform-env-check}

```
bwf env check [--remote]
```

Without `--remote`, validate `.env` plus the shell for local development. With `--remote`, validate build-shell client values and the remote server-secret names. Exits non-zero if a required key is missing or a readable value is invalid.

### `bwf env types` {#platform-env-types}

```
bwf env types
```

Regenerate `.bwf/env.d.ts` from `env.ts`. Normally happens automatically on dev server start and HMR; use this command after a fresh clone or to refresh stale types in non-dev contexts.

::: tip Deploy validation
`bwf deploy` runs the same schema validation automatically (with remote secrets) and refuses to upload if any required key is missing — no need to call `env check` separately when deploying.
:::

See [Environment Variables](../../guide/env-vars.md) for the full guide.
