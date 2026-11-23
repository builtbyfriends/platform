# bwf

React single-page apps with an optional backend on Cloudflare Workers, powered by Vite.

## Context Overview

- Documentation source lives in `docs/`.
  - Docs is a Vitepress project using our custom theme. When asked to "link the theme", temporarily edit `docs/package.json` so that `@voidzero-dev/vitepress-theme` point to `link:../../../theme`. Rerun `vp install` to link it. Revert these when asked to "unlink the theme".
- Packages publish to npm as `bwf` and `@builtbyfriends/*`. Consumer-facing code, docs examples, playground source, and package manifests should use only those public package names.
- Published external runtime dependencies use compatible semver ranges. Preserve `workspace:*` for dependencies and peers between bwf packages. The lockfile fixes the versions tested in this repository. Keep Miniflare's dated alpha coordinated with the Cloudflare toolchain: a caret does not accept the next date's alpha. Keep the Sandbox SDK version aligned with its packaged Docker helper and verified platform helper layer.

## Important Note for Release Workflows

The `bwf` package on npm has these previous versions: '0.0.1', '0.1.0', '0.1.2', '0.1.3', '0.1.5', '0.1.6', '1.0.0', '1.0.1', '1.0.2', '3.0.0', '3.0.1'. We have unpublished these versions but they cannot be published again. In package release workflows, make sure to avoid / skip these versions for `packages/bwf`.

Deploy hosted production before publishing the npm packages: the CLI checks the platform version. See [operations](./platform/meta/operations.md#github-actions).

## Best Practices That Must Be Followed

- **Comments are banned, apart from decision records.** The `bwf/no-comments` lint rule (`scripts/lint-plugin.mjs`) allows a comment that starts with `Decision:` and records a non-obvious decision, tool directives, license headers, JSDoc types in JS files, and JSDoc in published package source. Don't write a comment that repeats the code or excuses a shortcut: fix the code, or file a Linear issue. `.claude/skills/delete-comment/SKILL.md` has the audit steps.
- **Lint starts from Cloudflare's preset.** `vp lint` spreads `@cloudflare/oxlint-config` in `vite.config.ts`. It's type-aware, and its `quality/*` rules catch type shortcuts (`as unknown as T`, `object` parameters, `Record<string, unknown>`, conditional empty spreads). `eslint-plugin-react-you-might-not-need-an-effect` runs on top. A rule that still has reports in older code is in the `unfinishedRules` list, where it warns: fix its warnings in the files you touch, and take the rule off the list at zero. The type-aware lint reads each app's generated `.bwf/tsconfig.json`, so run `node scripts/lint-prepare.mjs` once after a build. `vp lint --fix` can rename a shorthand property when it renames a catch variable (`{ cause }` becomes `{ error }`), so check its diff. A cast the code needs at a boundary gets an `oxlint-disable-next-line <rule> -- <reason>`.
- **Do not use Python for repository scripts or automation**, including inline CI scripts and ad-hoc maintenance commands. Use Node.js with TypeScript/JavaScript, or shell/PowerShell where appropriate.
- **Keep user-facing documentation focused on using bwf.** Explain public APIs, configuration, observable behavior, and actions users need to take. Do not add implementation details, internal workarounds, defensive checks, normalization rules, or bug-fix history unless they help users make a decision or resolve an actionable problem. Maintainer-only knowledge belongs in `Decision:` comments in source, repository/package `AGENTS.md`, or contributor guides. This applies to app guides, API/CLI references, consumer-facing READMEs, and shipped app-development skills. Code examples should type-check. When an API does not infer a route, param, or path type, annotate the example with the public type that checks it, such as `PageParams`, `RouteUrl`, or `routeUrl()`.
- **Keep native Cloudflare deploys Workers Free-compatible by default.** New public bwf SDK/runtime features must work with `bwf deploy --platform cloudflare` on Workers Free unless the underlying Cloudflare product has no Free offering. Paid-only functionality must be explicitly opt-in, inferred and emitted only when the app uses it, and checked before provisioning or building. Its documentation and deploy error must name the required Cloudflare product/plan, link to enable it, and explain any API-token permissions. Platform-internal paid services must never become requirements of a single-app native Cloudflare deploy. Add regression coverage proving that an app which does not use the paid feature emits no paid binding and performs no entitlement probe.
- Every implementation plan should include the following:
  - During plan generation: ask clarifying questions when necessary, especially around developer-experience defining design decisions.
  - Verification:
    - Run `vp run check` for package typechecking after completing a batch of tasks.
    - During development, run an exact test file (and `-t` for a focused case) first. Use `vp run test --list` to inspect affected coverage, then `vp run test` for changed-file validation. Use `--base <ref>` when changes are already committed; the default includes only staged, unstaged, and untracked files.
    - `vp run test --unit` is an iteration-only shortcut, not integration verification. Native `vp test related --run <source>` misses filesystem/subprocess inputs; prefer the smart runner's conservative fallbacks before handing off. See `TESTING.md` for builds, integration selection, and import profiling.
    - Run `vp test run` once when everything is done for final verification. CI and `vpr test:all` retain full-suite coverage. Do not repeatedly run the full suite during iteration, enable result caching for the smart selector, or disable module isolation to make tests faster.
    - If there are tests hanging or running particularly slow, investigate right there and attempt to fix. Testing velocity is something that should be maintained or improved at every opportunity.
  - Documentation: after verification, update the relevant docs only when public behavior, configuration, or user workflows change. An internal fix often needs no user-facing documentation change:
    - `README.md`
    - affected packages's `README.md` or `AGENTS.md`
    - relevant docs md files in `docs`
    - `packages/bwf/skills/bwf` (if change affects skill/CLI guidance)
    - `packages/bwf/AGENTS_TEMPLATE.md` (keep at most four brief bullets; detailed guidance belongs in docs)
- When adding new CLI commands, always remember to update the following:
  - CLI help message
  - The hint message for command groups in the interactive list when running `bwf` with no args
  - `docs/reference/cli.md`

## Quick Reference

```
vp run build                        # Build all packages
vp run build:all                    # Build packages and playgrounds
vp run build:core                   # Build shared packages, CLI, and platform runtime
vp run test                         # Affected local tests, with integration fallbacks
vp run test --list                  # Preview affected test files without builds/hooks
vp run test --base origin/main      # Include committed branch changes
vp test run                         # Run tests (unit + integration tests)
vpr test:all                        # Format, lint, build, typecheck, and run all SDK/platform tests
vp test run packages/bwf           # Only test the core plugin
vp lint                             # Oxlint through Vite+
vp fmt                              # Oxfmt through Vite+
vp run check                        # Typecheck all packages with TypeScript
vp run --filter ./packages/vue typecheck # Typecheck a specific package
```

## Monorepo Structure

pnpm workspaces managed through Vite+. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (`typescript`, `vite-plus`, Vite+/Vitest aliases, `@cloudflare/workers-types`, wrangler). Make sure to run `vp install` after making package structure changes.

| Package                                                      | npm name                            | Purpose                                                           |
| ------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------- |
| [`packages/deploy-core`](./packages/deploy-core)             | `@builtbyfriends/deploy-core`       | Shared deployment manifests, events, and target-neutral contracts |
| [`packages/deploy-cloudflare`](./packages/deploy-cloudflare) | `@builtbyfriends/deploy-cloudflare` | Direct Cloudflare config and verified upload primitives           |
| [`packages/edge`](./packages/edge)                           | `@builtbyfriends/edge`              | Shared routing, headers, and static edge runtime                  |
| [`packages/platform`](./packages/platform/README.md)         | `@builtbyfriends/platform`          | Self-hosted installation contracts and packaged platform runtime  |
| [`packages/bwf`](./packages/bwf/AGENTS.md)                   | `bwf`                               | Core Vite plugin — routing, inference, migrations, CLI            |
| [`docs`](./docs)                                             | (private)                           | Documentation site (VitePress)                                    |
| [`platform`](./platform/README.md)                           | (private)                           | Self-hosted platform source, routing, proxy, logs, and dashboard  |
| `playground/*`                                               | (private)                           | local apps for testing                                            |

The platform source is part of this repository. Its workspace-only packages keep `private: true` to prevent accidental npm publication; this does not mean the platform source is private. Use `docs/guide/platform-development.md` for contributor/fork setup and `docs/guide/self-hosted-platform.md` for installation.

Platform packages live under `platform/packages/*` and may depend on public/shared root packages. Public SDK packages under `packages/*` must not import from `platform/`.

## Package guidance

Read [the core package instructions](./packages/bwf/AGENTS.md) for plugin,
runtime, code-generation and CLI invariants. Each framework adapter has its
own README under `packages/{react,vue,svelte,solid}`.
The [API reference](./docs/reference/api.md) and
[CLI reference](./docs/reference/cli.md) describe the supported public surface.

`packages/bwf/docs` is ignored by Git and copied from `docs/`
during the build. Edit the source documentation instead.

## Tooling

Use the versions declared in `.node-version`, the root `package.json`
and `pnpm-workspace.yaml`. Vite+ supplies build, test, lint, formatting and
packaging commands. Node supports TypeScript stripping without `tsx`.

The Analog playground's TypeScript version follows Angular's compiler
compatibility range independently of the workspace compiler.

Dependency compatibility pins: Analog and SvelteKit use TypeScript 6.

## Testing

Run affected local tests from root with `vp run test`; `vp test run` always runs the full suite.
See `TESTING.md` for minimal agent verification and profiling, and each package README for test listings.

## Playground

Local apps for testing features end-to-end. Run scripts with `vp run --filter ./playground/<app> <script>` (e.g. `vp run --filter ./playground/spa dev`).

Use the README and manifest in the relevant playground for its supported
commands and dependencies. See [TESTING.md](./TESTING.md) for focused test
targets and the shared browser fixtures.

`playground-local/` is gitignored and used for ad-hoc local testing apps that are not part of the codebase.

## Upstream sync

This repository is a fork of [Void](https://github.com/voidzero-dev/void). `UPSTREAM` records the last upstream commit we have reviewed. To bring in newer upstream commits, follow [the upstream-sync skill](./.agents/skills/upstream-sync/SKILL.md): `vp run upstream:sync status` lists them, and `vp run upstream:sync apply <sha>` merges one, renamed to our names.

## Pitfalls / Things That Broke

- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
- **Miniflare D1 `exec()` with multi-statement SQL** fails with `Cannot read properties of undefined (reading 'duration')`. Split into individual statements and use `db.batch(stmts.map(s => db.prepare(s)))` instead.
- **ArkType `ArkErrors.map()` returns `ArkErrors`** (not a plain array), causing `Response.json()` serialization to crash via its custom `toJSON()`. Use `Array.from(issues, mapper)` instead of `issues.map(mapper)` when flattening Standard Schema issues.
- **tsconfig `extends` does NOT merge `include`/`files`** — the child completely replaces the parent's. To make generated types discoverable, the `.bwf/tsconfig.json` uses `"files"` (inherited when the child doesn't specify `files`) rather than `"include"` (overridden by the child's `include`).
- **`declare module` augmentation requires `export {}`** at the top of the generated file. Without a top-level export/import, TypeScript treats it as an ambient module declaration (replaces the module entirely) rather than an augmentation (merges with existing exports). This hides runtime exports like `db` and `createDb`. Both `routes.d.ts` and `db.d.ts` use `export {}` to ensure augmentation semantics.
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `bwf`.
- **D1 does not allow `PRAGMA foreign_keys=OFF`** — D1 enforces `foreign_keys=ON` always. Drizzle-generated migrations that do table rebuilds (e.g. adding NOT NULL to an existing column) use `PRAGMA foreign_keys=OFF/ON`, which silently fails on D1. Hand-edit these to `PRAGMA defer_foreign_keys=on/off` instead, which defers FK checks to the end of the current transaction.
- **Vite config plugins option accepts array of plugins by default** - there is no need to spread plugins that export an array of plugins.
- **Solid `createComponent()` evaluates immediately** — unlike React's JSX (which creates lazy descriptors), Solid's `createComponent(Fn, props)` calls `Fn` right away. Context providers must wrap the _evaluation_ of child components, not the evaluated result. Build layout chains inside provider `children` getters, not before wrapping in providers.

## Writing for people

Zack's preference (2026-11-17) for text that people read: pages, docs, pull request descriptions, replies, and prompts for other agents.

- Use plain STE100 English with contractions.
- Leave out AI jargon and cheesy or inspirational phrasing.
- Stay away from rules, laws and absolutes, such as "every", "always", "never" and "the four rules". Zack calls this a common AI trap. Describe how things tend to work.
- Keep it high level and friendly, with enough technical detail to hold a reader.

This is about tone in writing. It doesn't loosen the working constraints in this file.

## The product and our own setup

This repository is part of the product. It's what people get for the apps they build, so it takes an app as input and doesn't know which app it is. dedworc is one of those apps, and the first one. The things only dedworc needs as that first user are our own setup, and they live in the Build repository.

So dedworc uses the product, and the product doesn't use, import or name anything from our own setup. `packages/bwf/test/unit/product-names.test.ts` checks this by failing when a tracked file here contains the app's name. A deliberate mention, such as this section, goes in the test's `allowed` list with a reason.

The full explanation is `docs/scopes.md` in the Crowded repository (https://github.com/builtbyfriends/crowded/blob/main/docs/scopes.md). The page for people is https://claude.ai/artifact/B6rVb55NfCuUenLokzrp6c.
