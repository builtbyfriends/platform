import {
  defineRegistry,
  withProcedureName,
  type AnalyticsProvider,
  type AnyProcedure,
  type Registry,
} from '@builtbyfriends/realtime';
import { analyticsEngine, fanOut, posthog } from '@builtbyfriends/realtime-analytics';
import { rpcHandler } from '@builtbyfriends/realtime-http';
import type { Hono } from 'hono';

/** The Analytics Engine binding bwf adds when an app has procedures. */
export const ANALYTICS_BINDING = 'ANALYTICS';
/** The Worker secret that turns on PostHog for procedure events. `POSTHOG_HOST` picks the region. */
export const POSTHOG_KEY = 'POSTHOG_KEY';
export const RPC_BASE_PATH = '/rpc';
export const MCP_PATH = '/mcp';

type ProcedureModule = readonly [prefix: string, exports: Record<string, unknown>];

/**
 * Every procedure a module exports, named from its file unless it named itself.
 * Unfinished builders are kept so the registry reports them instead of losing them.
 */
export function collectProcedures(modules: ReadonlyArray<ProcedureModule>): Array<AnyProcedure> {
  const found: Array<AnyProcedure> = [];
  for (const [prefix, exports] of modules) {
    for (const [exportName, value] of Object.entries(exports)) {
      const kind = (value as { '~realtime'?: unknown } | null)?.['~realtime'];
      if (kind !== 'procedure' && kind !== 'builder') {
        continue;
      }
      const name = [prefix, exportName === 'default' ? '' : exportName].filter(Boolean).join('.');
      found.push(withProcedureName(value as AnyProcedure, name));
    }
  }
  return found;
}

const consoleAnalytics: AnalyticsProvider = {
  name: 'console',
  track: (event) => console.log('[analytics]', JSON.stringify(event)),
};

const posthogWhenSet: AnalyticsProvider = {
  name: 'posthog',
  track(event, env: Record<string, unknown> | undefined) {
    const apiKey = env?.[POSTHOG_KEY];
    if (typeof apiKey !== 'string' || !apiKey) {
      return;
    }
    const host = typeof env?.POSTHOG_HOST === 'string' ? env.POSTHOG_HOST : undefined;
    return posthog({ apiKey, host }).track(event, env);
  },
};

/**
 * Builds the registry and serves it at /rpc. Called at the top of the generated route
 * table, so a registry problem stops the Worker from starting and the deploy fails.
 * Events go to Analytics Engine, and to PostHog when `POSTHOG_KEY` is set.
 * In dev, events go to the console, so a remote-mode session never writes to the
 * deployed project's Analytics Engine dataset.
 */
export function mountProcedures(
  app: Pick<Hono, 'all'>,
  modules: ReadonlyArray<ProcedureModule>,
  options: { dev: boolean; name: string; version: string },
): Registry {
  const registry = defineRegistry(collectProcedures(modules), {
    analytics: options.dev
      ? consoleAnalytics
      : fanOut(analyticsEngine({ binding: ANALYTICS_BINDING }), posthogWhenSet),
  });
  const rpc = rpcHandler(registry, {
    basePath: RPC_BASE_PATH,
    openapi: { title: options.name, version: options.version },
  });
  const handle = (c: {
    req: { raw: Request };
    env: unknown;
    executionCtx: { waitUntil(p: Promise<unknown>): void };
  }) => rpc(c.req.raw, c.env, { waitUntil: (p) => c.executionCtx.waitUntil(p) });
  app.all(RPC_BASE_PATH, handle);
  app.all(`${RPC_BASE_PATH}/*`, handle);
  // Decision: Every procedure that chose `.mcp()` is a tool. The MCP server loads on the first request,
  // so apps that never use it pay no startup cost.
  const mcp = (async () => {
    const { mcpHandler } = await import('@builtbyfriends/realtime-mcp');
    return mcpHandler(registry, { name: options.name, version: options.version, route: MCP_PATH });
  })();
  app.all(MCP_PATH, async (c) =>
    (await mcp)(c.req.raw, c.env, { waitUntil: (p) => c.executionCtx.waitUntil(p) }),
  );
  return registry;
}
