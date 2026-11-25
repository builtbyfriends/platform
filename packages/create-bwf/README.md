# create-bwf

Create a full-stack Vite app with bwf, ready for local development and deployment to Cloudflare.

## Getting Started

Use Node.js 24.22+ or 26.12+.

The packages live on GitHub Packages, which asks for a sign-in even to install. Make a classic GitHub token with `read:packages`, export it as `NODE_AUTH_TOKEN`, and add these two lines to `~/.npmrc` once:

```ini
@builtbyfriends:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then run:

```sh
npm create @builtbyfriends/bwf@latest my-app
cd my-app
npm run dev
```

Choose Vite+ or Vite, then React, Vue, Svelte, or Solid. Pick a D1, PostgreSQL, MySQL, or Static Pages starter. The wizard installs dependencies and sets up TypeScript and coding agents; choose Cloudflare to deploy to your account, or connect to a team platform.

When you're ready to deploy:

```sh
npx bwf deploy
```

## Documentation

Follow the Quickstart to explore your new app. For an existing Vite app, install `bwf` and run `npx bwf init`.

Read the bwf documentation online or use the Markdown guides and references in `node_modules/@builtbyfriends/bwf/docs/`, included with the `bwf` package.
