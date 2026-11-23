import type { RouteEnvironment } from './router/parse-filename.ts';

export function hasBinding(list: Array<{ binding: string }> | undefined, name: string): boolean {
  return Array.isArray(list) && list.some((b) => b.binding === name);
}

/**
 * Decide whether to inject the `bwf dev` email-inbox loopback var.
 *
 * The dev inbox buffer lives in the Vite dev server's Node process;
 * `sendEmail` runs in workerd and reaches it by fetching the inbox capture
 * endpoint through the worker's assets binding, which
 * `@cloudflare/vite-plugin` wires straight into the dev server's middleware
 * stack. The var carries that binding's NAME (`ASSETS` for a bwf app) and its
 * presence is what arms the dev path at runtime — so it must never reach a
 * production build's `wrangler.json`, exactly like the `__PLATFORM_TOKEN`
 * credential gate.
 *
 * Gated on `routeEnvironment`, not on `command`: `vite preview` also reports
 * `command: 'serve'`, but it runs the BUILT worker whose assets binding is a
 * real asset directory rather than a dev-server loopback. `routeEnvironment`
 * is the existing `command === 'serve' && !isPreview` distinction.
 *
 * Without an assets binding there is no loopback, so injecting the var would
 * only arm a path that must then fail; gate on it instead.
 */
export function shouldInjectEmailDevInboxVar(
  routeEnvironment: RouteEnvironment,
  needsEmail: boolean | undefined,
  assetsBinding: string | undefined,
): boolean {
  return (
    routeEnvironment === 'dev' &&
    !!needsEmail &&
    typeof assetsBinding === 'string' &&
    !!assetsBinding
  );
}
