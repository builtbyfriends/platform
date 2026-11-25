---
description: 'See how the React app, routes, middleware, and other optional directories map onto a bwf app.'
outline: deep
---

<script setup>
const items = [
  { name: "src/", description: "React single-page app", link: "#src" },
  { name: "index.html", description: "SPA entry document", link: "#src" },
  { name: "routes/", description: "API endpoints (file-based routing)", link: "#routes" },
  { name: "middleware/", description: "Global request middleware", link: "#middleware" },
  { name: "db/", description: "Drizzle schema and SQL migrations", link: "#db" },
  { name: "crons/", description: "Scheduled cron jobs", link: "#crons" },
  { name: "queues/", description: "Async queue consumers", link: "#queues" },
  { name: "email/", description: "Inbound email handlers", link: "#email" },
  { name: "durable-objects/", description: "Durable State modules", link: "#durable-objects" },
  { name: "public/", description: "Static assets (served as-is)", link: "#public" },
  { name: ".bwf/", description: "Auto-generated (gitignored)", link: "#void" },
  { name: "vite.config.ts", description: "Vite config with bwfPlugin()", link: "#config-files" },
  { name: "bwf.config.ts", description: "bwf project config (optional)", link: "#config-files" },
  { name: "oxlint.config.ts", description: "Lint config from the bwf preset", link: "#config-files" },
  { name: ".env", description: "Local environment values", link: "#config-files" },
  { name: "env.ts", description: "Environment schema", link: "#config-files" },
  { name: "package.json" },
  { name: "tsconfig.json" },
];

const middlewareItems = [
  {
    name: "middleware/",
    children: [
      { name: "01.logger.ts", description: "Runs first" },
      { name: "02.auth.ts", description: "Runs second" },
    ],
  },
];

const dbItems = [
  {
    name: "db/",
    children: [
      { name: "schema.ts", description: "Drizzle schema (source of truth)" },
      { name: "schema/", description: "Optional: split into multiple files" },
      {
        name: "migrations/",
        children: [
          { name: "20260410161500_*.sql" },
          { name: "20260410161501_*.sql" },
        ],
      },
    ],
  },
];

</script>

# Project Structure

## Overview

A bwf app is a React single-page app (`index.html` + `src/`) with optional file-based conventions for API routes, middleware, and more. All directories are optional, so you only need the pieces your app actually uses.

<FileTree :items="items" />

## `routes/`

File-based HTTP API endpoints built on [Hono](https://hono.dev). Each file exports named HTTP method handlers.

<RoutesFileTree />

- **Named exports**: `export const GET = defineHandler(...)`, `export const POST = ...`
- **Extensions**: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, or `.mjs`; use `.tsx` or `.jsx` for JSX handlers
- **Dynamic segments**: `[id]` becomes `:id` route parameter
- **Catch-all**: `[...slug]` matches the remaining path
- **Route groups**: `(admin)/` organizes files without affecting URL paths
- **Files starting with `_`** are ignored
- **Environment suffix**: `debug.dev.ts` builds in development only, `metrics.prod.ts` in production only

See [Server Routing](/guide/server-routing) for the full guide.

## `middleware/`

Global middleware that runs on every request. Numeric prefixes control execution order.

<FileTree :items="middlewareItems" default-expanded />

Each file default-exports a `defineMiddleware()` handler. Use middleware to set shared context (auth, logging, rate limiting) available to all routes.

## `db/`

[Drizzle schemas](/guide/database#schema-definition) and SQL migrations for D1, PostgreSQL, or MySQL.

<FileTree :items="dbItems" default-expanded />

- `db/schema.ts`: your Drizzle table definitions and the source of truth for DB types
- `db/schema/`: optional. Split tables into separate files and re-export them from `db/schema.ts`
- `db/migrations/`: generated SQL migration files, applied in order on deploy

Generate schema with `bwf gen model` or write it by hand. Generate migrations with `bwf db generate`.

## `crons/`

[Scheduled jobs](/guide/jobs). Each file exports a `cron` expression and a default `defineScheduled()` handler.

## `queues/`

[Queue consumers](/guide/queues). Each file default-exports a `defineQueue()` handler.

## `email/`

[Inbound email handlers](../guide/email/receiving.md#inbound). A file's name selects the recipient; `_default.ts` handles other addresses.

## `durable-objects/`

[Durable State](/guide/durable-state) modules. Each file default-exports a `defineDurableState()` definition.

## `src/`

The React single-page app. `index.html` loads `src/main.tsx`, which renders the app in the browser; Vite bundles it into static assets. Beyond that entry, organize components, utilities, and types however you like.

## `public/`

Static assets served as-is at the root path. Files here are not processed by Vite.

## `.bwf/`

Generated types and local development state (gitignored). Run `bwf prepare` to create the types, or let `vite dev` and `vite build` update them.

## Config Files

| File               | Purpose                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.ts`   | Vite configuration. Must include `bwfPlugin()`.                                                                                                         |
| `bwf.config.ts`    | Optional bwf config for [routing](/reference/config#routing), [inference](/reference/config#inference), and [worker settings](/reference/config#worker) |
| `oxlint.config.ts` | Oxlint config. The starter uses `@builtbyfriends/bwf/lint`, the checks bwf apps share. Add or relax rules on top of it.                                 |
| `tsconfig.json`    | TypeScript config. Extend `.bwf/tsconfig.json` for auto-generated types; run `bwf init --tsconfig` when an existing config already uses `extends`.      |
| `.env`             | Local development values only (gitignored; never deployed)                                                                                              |
| `env.ts`           | Checked-in env names, types, defaults, and requiredness                                                                                                 |

See [Environment Variables](/guide/env-vars) for local, production-secret, and client build behavior.
