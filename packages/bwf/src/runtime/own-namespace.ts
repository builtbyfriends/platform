import { exports as workerExports } from 'cloudflare:workers';

// Decision: A Worker Preview gets its own Durable Object namespace only for the Worker's own exports (ctx.exports), and
// leaves the env binding to the Worker's own class out. Runtime code that reaches one of the app's own classes by its
// binding name therefore reads the export first. Outside a preview the export and the env binding are the same
// namespace, so an app with no preview behaves as before.
export function ownNamespace<T>(
  env: Record<string, unknown>,
  bindingName: string,
  className: string | undefined,
): T | undefined {
  const exports: Record<string, unknown> | undefined = workerExports;
  const exported = className === undefined ? undefined : exports?.[className];

  // Decision: both sources hold the class's namespace, and the caller names its type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the caller names T
  return (exported ?? env[bindingName]) as T | undefined;
}
