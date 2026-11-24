import type { RuntimeEnvironment } from './routing-worker.ts';

// Decision: `c.rewrite()` cannot reach files the asset layer serves. `.html` is excluded: routes may use it.
export const ASSET_EXTENSIONS: Array<string> = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'css',
  'js',
  'mjs',
  'cjs',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp4',
  'webm',
  'mp3',
  'wav',
  'pdf',
  'txt',
  'xml',
  'json',
  'wasm',
  'map',
];

export type ClientManifest = Record<
  string,
  {
    file?: string;
    imports?: Array<string>;
    css?: Array<string>;
    /** Build-proven fingerprinted outputs; absent in older/third-party manifests. */
    immutableFiles?: Array<string>;
  }
>;
export type ManifestLoader = (
  request: Request,
  env: RuntimeEnvironment,
) => Promise<ClientManifest | null>;
export function createManifestLoader(): ManifestLoader {
  let cached: ClientManifest | null = null;
  return async (request, env) => {
    if (cached) {
      return cached;
    }
    const injected = (globalThis as typeof globalThis & { __VITE_MANIFEST__?: unknown })
      .__VITE_MANIFEST__;
    if (typeof injected === 'object' && injected) {
      cached = injected as ClientManifest;
      return cached;
    }
    const assets = env?.ASSETS;
    if (!assets || typeof assets.fetch !== 'function') {
      return null;
    }
    // Decision: Workers scope I/O to the request that starts it. A fetch shared across requests can
    // stay unsettled when its request is canceled, and every later request would wait on it. So only
    // the parsed manifest is cached, and a failed load retries on the next request.
    const response = await assets.fetch(
      new Request(new URL('/.vite/manifest.json', request.url).toString()),
    );
    if (!response.ok) {
      return null;
    }
    cached = (await response.json()) as ClientManifest;
    return cached;
  };
}
