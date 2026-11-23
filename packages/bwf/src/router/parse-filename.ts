import { ROUTE_EXTENSIONS } from '../shared/route-extensions.ts';

export type RouteEnvironment = 'dev' | 'prod';

export type RouteDefinition = {
  /** URL pattern, e.g. "/api/users/:id" */
  pattern: string;
  /** HTTP methods detected from named exports (e.g. ["GET", "POST"]) */
  methods: Array<string>;
  /** Parameter names extracted from the pattern */
  params: Array<string>;
  /** Whether this route has a catch-all parameter */
  catchAll: boolean;
  /** Environment restriction: "dev", "prod", or null */
  env: RouteEnvironment | null;
  /** Original relative file path */
  filePath: string;
};

const ENV_SUFFIXES: Array<RouteEnvironment> = ['dev', 'prod'];

function parsePath(relativePath: string, isWebSocketRoute: boolean): RouteDefinition {
  const filePath = relativePath;

  let path = relativePath.replaceAll('\\', '/');

  for (const ext of ROUTE_EXTENSIONS) {
    if (path.endsWith(`.${ext}`)) {
      path = path.slice(0, -(ext.length + 1));
      break;
    }
  }

  if (isWebSocketRoute && path.endsWith('.ws')) {
    path = path.slice(0, -3);
  }

  const segments = path.split('/');
  let filename = segments.pop()!;

  let env: RouteEnvironment | null = null;
  for (const suffix of ENV_SUFFIXES) {
    if (filename.endsWith(`.${suffix}`)) {
      env = suffix;
      filename = filename.slice(0, -(suffix.length + 1));
      break;
    }
  }

  segments.push(filename);

  if (segments.at(-1) === 'index') {
    segments.pop();
  }

  const filtered = segments.filter((s) => !s.startsWith('(') || !s.endsWith(')'));

  const params: Array<string> = [];
  let catchAll = false;

  const converted = filtered.map((segment) => {
    if (segment.startsWith('[...') && segment.endsWith(']')) {
      const paramName = segment.slice(4, -1);
      catchAll = true;
      if (paramName) {
        params.push(paramName);
        return `:${paramName}{.+}`;
      }
      return '*';
    }
    if (segment.startsWith('[') && segment.endsWith(']')) {
      const paramName = segment.slice(1, -1);
      params.push(paramName);
      return `:${paramName}`;
    }
    return segment;
  });

  const pattern = '/' + converted.join('/');

  return {
    pattern,
    methods: [] /* Decision: The scanner fills `methods` in later from the file's exports. */,
    params,
    catchAll,
    env,
    filePath,
  };
}

/**
 * Parse a route filename (relative to routes/) into a RouteDefinition.
 *
 * Rules (applied in order):
 * 1. Strip file extension (.ts, .tsx, .js, .jsx, .mts, .mjs)
 * 2. Check for env suffix (.dev, .prod) → strip and record
 * 3. Strip trailing "index" segment
 * 4. Remove route group directories: (groupname)
 * 5. Convert [param] → :param, [...param] → :param{.+}, [...] → *
 * 6. Prefix with /
 */
export function parseRouteFilename(relativePath: string): RouteDefinition {
  return parsePath(relativePath, false);
}

/** Parse a `.ws.*` route filename into a regular route definition. */
export function parseWebSocketFilename(relativePath: string): RouteDefinition {
  return parsePath(relativePath, true);
}

export function isRouteEnabledForEnvironment(
  route: Pick<RouteDefinition, 'env'>,
  environment?: RouteEnvironment,
): boolean {
  return environment === undefined || route.env === null || route.env === environment;
}
