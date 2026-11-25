# bwf

bwf builds and deploys React single-page apps to Cloudflare Workers. An app can have a backend too.

bwf is a fork of [Void](https://github.com/builtbyfriends/platform) by Cloudflare. We forked it for two reasons:

- We wanted Void's base for the Build platform. We also want to see if the principles and design patterns of UI-SDK work for infrastructure too.
- Void is very good. If we started again and tried to make our own clean solution, we don't think it'd be better than Void or much different.

## What's in it

- **SDK:** Write the app and its backend together. API routes come from files, and the APIs for databases, storage and AI are typed. Types carry from a database query to the UI.
- **CLI:** Build the app, make the Cloudflare resources it uses, apply migrations and deploy, all with one command. The same CLI manages resources, shows logs and rolls back.
- **Platform:** A shared deploy environment that you install in your Cloudflare account for your team or your customers. It has access controls, resource limits and usage reports.

You don't need all of the SDK. You can start with a plain React app and add API routes, a database, auth or jobs later.

## Get started

You need Node.js 24.22 or newer.

The packages live on GitHub Packages, which asks for a sign-in even to install. Make a classic GitHub token with `read:packages`, export it as `NODE_AUTH_TOKEN`, and add these two lines to `~/.npmrc` once:

```ini
@builtbyfriends:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then, in an empty folder, run:

```sh
npm install -D @builtbyfriends/bwf
npx bwf init
npm run dev
```

To deploy to your Cloudflare account, run:

```sh
npx bwf deploy
```

bwf builds the app, makes the resources, applies migrations and prints the URL. To deploy to a team platform, run `npx bwf connect <url>` first.

## Docs

The guides are in [`docs/guide/`](./docs/guide/index.md). Start with the [quickstart](./docs/guide/quickstart.md). The package also has a copy in `node_modules/@builtbyfriends/bwf/docs/`.

## Work on bwf

```sh
git clone --recurse-submodules https://github.com/builtbyfriends/platform.git
cd platform
vp install
vp run build
```

`vp run dev:docs` shows the docs locally. [TESTING.md](./TESTING.md) has the checks to run.

## License

[MIT](./LICENSE). The original Cloudflare copyright notice stays in the license and in [NOTICE](./NOTICE).
