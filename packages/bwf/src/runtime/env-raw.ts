/**
 * Raw runtime env resolution — framework-internal only.
 *
 * This module is NOT exported in package.json, so it cannot be imported
 * via "@builtbyfriends/bwf/..." subpaths. Only framework modules can import it by relative path.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

// oxlint-disable-next-line quality/no-unsafe-dictionary-type -- bindings are platform-defined
export type RuntimeEnv = Record<string, unknown>;

/** Prefixes for platform-internal bindings that must be hidden from user code. */
export const INTERNAL_BINDING_PREFIXES = ['__PLATFORM_', '__PROJECT_'] as const;

/**
 * One process or isolate can evaluate this module more than once: Vite's SSR module
 * runner keeps its own copy beside a package it leaves external, and a dependency
 * optimizer reload re-evaluates it while a request is in flight. Every copy must read
 * the env of the current request, so the store lives on `globalThis`, like
 * `authContext`. Two bwf versions in one process share it: change the key when the
 * store shape changes.
 */
const ENV_CONTEXT_SYMBOL: unique symbol = Symbol.for('bwf.envContext.v1');
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis slot keyed by a symbol
const shared = globalThis as { [ENV_CONTEXT_SYMBOL]?: AsyncLocalStorage<RuntimeEnv> };
shared[ENV_CONTEXT_SYMBOL] ??= new AsyncLocalStorage<RuntimeEnv>();
export const envContext: AsyncLocalStorage<RuntimeEnv> = shared[ENV_CONTEXT_SYMBOL];

let cloudflareEnv: RuntimeEnv | undefined;

// Decision: Synchronous detection: navigator.userAgent is "Cloudflare-Workers" in workerd
// (default since compat date 2022-03-21). Only attempt the dynamic import when
// we know we're in workerd — avoids silent .catch() on Node/Bun/Deno.
// Built-in module imports resolve before the runtime dispatches its first request,
// so cloudflareEnv is guaranteed to be set by the time any handler runs.
const isWorkerd = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

if (isWorkerd) {
  // oxlint-disable-next-line unicorn/prefer-top-level-await -- awaiting would block module evaluation
  import('cloudflare:workers')
    .then((mod) => {
      cloudflareEnv = asEnv((mod as { env?: unknown }).env) ?? undefined;
    })
    .catch(() => {});
}

function asEnv(value: unknown): RuntimeEnv | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  if ('then' in value && typeof (value as { then?: unknown }).then === 'function') {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- env bindings object has no known shape
  return value as RuntimeEnv;
}

function getGlobalEnv(): RuntimeEnv | null {
  return asEnv((globalThis as RuntimeEnv & { __env__?: unknown }).__env__);
}

/** Resolve raw env from AsyncLocalStorage, the ambient `globalThis.__env__`, or CF module env. */
export function getRawRuntimeEnv(): RuntimeEnv {
  return (
    envContext.getStore() ??
    getGlobalEnv() ??
    cloudflareEnv ??
    (() => {
      throw new Error(
        'env: Cloudflare env is unavailable. Use void runtime bindings inside Worker handlers.',
      );
    })()
  );
}

export { asEnv };
