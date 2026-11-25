---
description: 'Create a bwf app, run it locally, and deploy it. You can also add bwf to an existing Vite app.'
outline: deep
---

# Quickstart

Create a bwf app, run it locally, and deploy it. You can also [add bwf to an existing Vite app](#adding-to-an-existing-vite-app).

## Create an app

The packages live on GitHub Packages, which asks for a sign-in even to install. Make a classic GitHub token with `read:packages`, export it as `NODE_AUTH_TOKEN`, and add these two lines to `~/.npmrc` once:

```ini
@builtbyfriends:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then, in an empty directory, install bwf and run setup:

::: code-group

```sh [npm]
npm install -D @builtbyfriends/bwf
npx bwf init
```

```sh [pnpm]
pnpm add -D @builtbyfriends/bwf
pnpm bwf init
```

```sh [yarn]
yarn add -D @builtbyfriends/bwf
yarn bwf init
```

```sh [bun]
# bunx runs bwf with the `node` on your PATH: use Node.js 24.22+ or 26.12+
bun add -D @builtbyfriends/bwf
bunx bwf init
```

```sh [vp]
vp add -D @builtbyfriends/bwf
vpx bwf init
```

:::

Choose your UI framework, a starter, and a deployment target. Vite+ is the default build tool. D1 is a good first database: it runs locally without a separate database server. Choose Cloudflare to deploy to your own account, or skip deployment setup for now.

You do not need to install Vite+ globally. Setup preserves your existing package-manager versions and lockfiles.

With pnpm, `pnpm create @builtbyfriends/bwf my-app` also creates the project directory and configures native build permissions for you.

## Run locally

::: code-group

```sh [npm]
npm run dev
```

```sh [pnpm]
pnpm run dev
```

```sh [yarn]
yarn run dev
```

```sh [bun]
bun run dev
```

```sh [vp]
vpr dev
```

:::

Open `http://localhost:5173`. `src/` contains your React app, and `routes/` contains the server routes it calls.

## Call a server route

Edit `routes/api/hello.ts`, or create it if your starter doesn't include it:

```ts
import { defineHandler } from '@builtbyfriends/bwf';

export const GET = defineHandler(() => {
  return { message: 'Hello from bwf' };
});
```

Visit `http://localhost:5173/api/hello` to see the response. From your client code, call it with bwf's typed fetch:

```ts
import { fetch } from '@builtbyfriends/bwf/client';

const { message } = await fetch('/api/hello');
```

The file path defines the URL, and the handler defines the response type. Change `message` in the handler and TypeScript checks the client against the new shape.

Database starters also include `db/schema.ts`. Its Drizzle schema defines your tables and query types; bwf runs a local database and provisions one when you deploy.

## Deploy

If you chose a target during setup:

```sh
npx bwf deploy
```

If you skipped setup, select your Cloudflare account:

```sh
npx bwf deploy --platform cloudflare
```

bwf opens your browser to sign in when needed, builds the app, provisions resources, applies migrations, and prints the deployed URL. Later deploys use the saved target. See [Deployment](./deployment.md) for team platforms, CI, and rollback.

## Adding to an existing Vite app

Install bwf and run `bwf init` with your package manager as shown [above](#create-an-app). Setup adds `bwfPlugin()` to your Vite config and creates the remaining project files. If the config needs a manual edit, the CLI shows the change to make.

## Next steps

- [Server Routing](./server-routing.md): params, middleware, and validation
- [Database](./database.md): queries and migrations
- [Environment Variables](./env-vars.md): local values and production secrets
- [Coding Agents](../integrations/agents.md): use bwf's bundled docs and skills

If a manual pnpm install reports blocked build scripts, run `pnpm approve-builds` for `esbuild`, `sharp`, and `workerd`. Set `better-sqlite3: false` and `core-js-pure: false` in `pnpm-workspace.yaml`'s `allowBuilds`; bwf uses better-sqlite3's bundled binaries, and core-js-pure's script only prints a message.
