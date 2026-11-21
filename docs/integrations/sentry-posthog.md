---
description: 'Send errors and traces to Sentry, and procedure events to PostHog, by installing a package and setting a secret.'
outline: deep
---

# Sentry and PostHog

## Sentry

Install Sentry's Cloudflare SDK in your app:

```bash
bun add @sentry/cloudflare
```

When the app depends on it, bwf adds Sentry's Vite plugin to the build. The plugin wraps the Worker and each Durable Object, and instruments libraries such as Hono and AI clients at build time. Set the DSN as a secret:

```bash
cf workers secrets update SENTRY_DSN --worker <worker> --type secret_text --text "$SENTRY_DSN"
```

Without `SENTRY_DSN` the SDK stays off. `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` and `SENTRY_TRACES_SAMPLE_RATE` are read the same way.

For more options, add `instrument.server.ts` next to `bwf.config.ts`. Its default export gets `env` and returns Sentry's options:

```ts
import type { CloudflareOptions } from '@sentry/cloudflare';

export default (env: { SENTRY_DSN?: string }): CloudflareOptions => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 1,
  enableLogs: true,
});
```

A Durable Object that extends `Agent` from the Agents SDK takes Sentry's Agent wrapper in its own file: `defineDurableObject({ class: instrumentAgentWithSentry(options, MyAgent) })`.

## PostHog

Procedures that call `.analytics()` send their event to Workers Analytics Engine. Set `POSTHOG_KEY` to your PostHog project key and the same events also go to PostHog. `POSTHOG_HOST` picks the region, and defaults to `https://us.i.posthog.com`.

```bash
cf workers secrets update POSTHOG_KEY --worker <worker> --type secret_text --text "$POSTHOG_KEY"
```

Events from a signed-in caller use the caller's id as PostHog's `distinct_id`. Anonymous calls are sent without a person profile.
