import { describe, expect, it } from 'vite-plus/test';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import type { ScanResult } from '../../src/router/scan.ts';

function makeScan({
  routes = [],
  websockets,
}: {
  routes?: ScanResult['routes'];
  websockets?: ScanResult['websockets'];
} = {}): ScanResult {
  return {
    routes,
    websockets,
    middleware: [],
    jobs: [],
    queues: [],
  };
}

describe('generateRouteTypes', () => {
  it('generates route type declarations for single-method routes', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');

    expect(dts).toContain('declare module "@builtbyfriends/bwf/routes"');
    expect(dts).toContain('"/api/hello"');
    expect(dts).toContain('GET: {');
    expect(dts).toContain('typeof import("../routes/api/hello.ts")');
    expect(dts).toContain('input:');
    expect(dts).toContain('output:');
  });

  it('generates multi-method routes', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/users',
          methods: ['GET', 'POST'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/users/index.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');

    expect(dts).toContain('GET: {');
    expect(dts).toContain('POST: {');
    expect(dts).toContain('typeof import("../routes/api/users/index.ts")');
  });

  it('emits one route key and preserves methods from colliding route files', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/health',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/health.ts',
        },
        {
          pattern: '/api/health',
          methods: ['POST'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/health/index.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');
    const routeMap = dts
      .split('  interface RouteMap {')[1]
      .split('  interface WebSocketRouteMap {')[0];

    expect(routeMap.match(/"\/api\/health": \{/g)).toHaveLength(1);
    expect(routeMap).toContain('GET: {');
    expect(routeMap).toContain('POST: {');
    expect(routeMap).toContain('typeof import("../routes/api/health.ts")');
    expect(routeMap).toContain('typeof import("../routes/api/health/index.ts")');
  });

  it('combines colliding environment-specific methods conservatively', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/health',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: 'dev',
          filePath: 'api/health.dev.ts',
        },
        {
          pattern: '/api/health',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: 'prod',
          filePath: 'api/health.prod.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');
    const routeMap = dts
      .split('  interface RouteMap {')[1]
      .split('  interface WebSocketRouteMap {')[0];

    expect(routeMap.match(/"\/api\/health": \{/g)).toHaveLength(1);
    expect(routeMap.match(/GET: \{/g)).toHaveLength(1);
    expect(routeMap).toMatch(/input: .*health\.dev\.ts.* & .*health\.prod\.ts/);
    expect(routeMap).toMatch(/output: .*health\.dev\.ts.* \| .*health\.prod\.ts/);
  });

  it('keeps default-export routes out of RouteMap but in RoutePathMap', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/legacy',
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/legacy.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');
    const routeMap = dts.split('  interface RouteMap {')[1].split('\n  }')[0];
    const pathMap = dts.split('  export interface RoutePathMap {')[1].split('  }')[0];

    expect(routeMap).not.toContain('/api/legacy');
    expect(pathMap).toContain('"/api/legacy": never;');
  });

  it('handles dynamic params in patterns', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/users/:id',
          methods: ['GET'],
          params: ['id'],
          catchAll: false,
          env: null,
          filePath: 'api/users/[id].ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');

    expect(dts).toContain('"/api/users/[id]": {');
    expect(dts).toContain('/** @deprecated Use "/api/users/[id]" instead. */');
    expect(dts).toContain('"/api/users/:id": RouteMap["/api/users/[id]"];');
    expect(dts).toContain('typeof import("../routes/api/users/[id].ts")');
  });

  it('includes Serialize and ExtractInput helper types', () => {
    const { dts } = generateRouteTypes(makeScan(), '/project/routes', '/project/.bwf');

    expect(dts).toContain('type Serialize<T>');
    expect(dts).toContain('type ExtractInput<V>');
    expect(dts).toContain('StandardSchemaV1');
  });

  it('includes export {} so declare module is an augmentation', () => {
    const { dts } = generateRouteTypes(makeScan(), '/project/routes', '/project/.bwf');

    expect(dts).toContain('export {}');
  });

  it('emits RouteName and RewriteDestination aliases on bwf/routes', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');

    // Decision: Both exports have to live inside the `declare module "@builtbyfriends/bwf/routes"` block so
    // consumers importing from `@builtbyfriends/bwf/routes` pick them up after codegen.
    const moduleBlockStart = dts.indexOf('declare module "@builtbyfriends/bwf/routes"');
    expect(moduleBlockStart).toBeGreaterThan(-1);
    const moduleBlock = dts.slice(moduleBlockStart);

    expect(moduleBlock).toContain('export type RouteName = keyof RouteMap;');
    // Decision: The `(string & {})` trick keeps route-name autocomplete while still accepting dynamic paths
    // like `/users/${id}`.
    expect(moduleBlock).toContain('export type RewriteDestination = RouteName | (string & {});');
  });

  it('emits percent-encoded spellings only for fixed segments that need encoding', () => {
    const route = (pattern: string, params: Array<string> = []) => ({
      pattern,
      methods: ['GET'],
      params,
      catchAll: false,
      env: null,
      filePath: `${pattern}.ts`,
    });
    const scan = makeScan({
      routes: [
        route('/café menu'),
        route('/café/:id', ['id']),
        route('/files/:path{.+}', ['path']),
        route('/docs/*'),
        route('/api/users/:id', ['id']),
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');
    const encoded = dts.split('  export interface EncodedRoutePathMap {')[1].split('  }')[0];

    expect(encoded.trim().split('\n')).toEqual([
      '"/café menu": "/caf%C3%A9%20menu";',
      '    "/café/[id]": "/caf%C3%A9/[id]";',
      '    "/café/:id": "/caf%C3%A9/:id";',
    ]);
    expect(dts).toContain(
      'type RoutePathUrl = RoutePatternUrl<CheckedRoutePath<RoutePath | EncodedRoutePath>>;',
    );
  });

  it('turns on typed route URLs only when routing.typedRoutes is set', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
      ],
    });
    const typesConfig = (dts: string) =>
      dts.split('  export interface RouteTypesConfig {')[1].split('  }')[0];

    const off = generateRouteTypes(scan, '/project/routes', '/project/.bwf').dts;
    const on = generateRouteTypes(scan, '/project/routes', '/project/.bwf', {
      typedRoutes: true,
    }).dts;

    expect(typesConfig(off).trim()).toBe('');
    expect(typesConfig(on).trim()).toBe('typedRoutes: true;');
    expect(on.replace('    typedRoutes: true;\n', '')).toBe(off);
    expect(off).toContain('export type RouteUrlInput = Href | URL | RouteDestination;');
    expect(off).toContain('  ): RouteUrl;');
  });

  it('generates WebSocketRouteMap entries', () => {
    const scan = makeScan({
      websockets: [
        {
          pattern: '/chat/:room',
          methods: [],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ws.ts',
          className: 'ChatRoomWs',
          bindingName: 'ChatRoomWs',
          mode: 'room',
          hasAuthGate: true,
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');

    expect(dts).toContain('interface WebSocketRouteMap');
    expect(dts).toContain('"/chat/:room"');
    expect(dts).toContain('typeof import("../routes/chat/[room].ws.ts")');
    expect(dts).toContain('client:');
    expect(dts).toContain('server:');
    expect(dts).toContain('params: RouteParams<["room"]>');
    expect(dts).toContain(
      'actions: NonNullable<(typeof import("../routes/chat/[room].ws.ts"))["default"]["actions"]>;',
    );
  });

  it('omits actions for socket routes', () => {
    const scan = makeScan({
      websockets: [
        {
          pattern: '/feed',
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'feed.ws.ts',
          className: 'FeedWs',
          bindingName: 'FeedWs',
          mode: 'socket',
          hasAuthGate: false,
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');
    const websocketMap = dts.split('  interface WebSocketRouteMap {')[1].split('\n  }\n}')[0];

    expect(websocketMap).toContain('params: RouteParams<[]>');
    expect(websocketMap).not.toContain('actions:');
  });

  it('emits one WebSocket route key for colliding route files', () => {
    const websocket = {
      pattern: '/chat/:room',
      methods: [],
      params: ['room'],
      catchAll: false,
      env: 'dev' as const,
      filePath: 'chat/[room].dev.ws.ts',
      className: 'ChatRoomDevWs',
      bindingName: 'ChatRoomDevWs',
      mode: 'room' as const,
      hasAuthGate: true,
    };
    const scan = makeScan({
      websockets: [
        websocket,
        {
          ...websocket,
          env: 'prod',
          filePath: 'chat/[room].prod.ws.ts',
          className: 'ChatRoomProdWs',
          bindingName: 'ChatRoomProdWs',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');
    const websocketMap = dts.split('  interface WebSocketRouteMap {')[1].split('\n  }\n}')[0];

    expect(websocketMap.match(/"\/chat\/\[room\]": \{/g)).toHaveLength(1);
    expect(websocketMap).toContain('"/chat/:room": WebSocketRouteMap["/chat/[room]"];');
    expect(websocketMap).toContain('chat/[room].dev.ws.ts');
    expect(websocketMap).toContain('chat/[room].prod.ws.ts');
    expect(websocketMap).toMatch(/client: .*dev\.ws\.ts.* & .*prod\.ws\.ts/);
    expect(websocketMap).toMatch(/server: .*dev\.ws\.ts.* \| .*prod\.ws\.ts/);
    expect(websocketMap).toMatch(/actions: .*dev\.ws\.ts.* \| .*prod\.ws\.ts/);
  });

  it('generates URL patterns for API and WebSocket routes', () => {
    const route = (pattern: string, params: Array<string>, filePath: string) => ({
      pattern,
      methods: ['GET'],
      params,
      catchAll: pattern.includes('{.+}') || pattern.endsWith('*'),
      env: null,
      filePath,
    });
    const scan = makeScan({
      routes: [
        { ...route('/api/users/:id', ['id'], 'api/users/[id].ts'), methods: ['POST'] },
        route('/about', [], 'about.ts'),
        route('/files/:path{.+}', ['path'], 'files/[...path].ts'),
        route('/files/*', [], 'files/[...].ts'),
      ],
      websockets: [
        {
          pattern: '/chat/:room',
          params: ['room'],
          methods: [],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ws.ts',
          bindingName: 'CHAT_ROOM',
          className: 'ChatRoom',
          mode: 'room',
          hasAuthGate: false,
        },
      ],
    });
    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.bwf');
    const pathMap = dts.split('  export interface RoutePathMap {')[1].split('  }')[0];
    expect(pathMap).toContain('"/api/users/[id]": "id";');
    expect(pathMap).toContain('"/api/users/:id": RoutePathMap["/api/users/[id]"];');
    expect(pathMap).toContain('"/about": never;');
    expect(pathMap).toContain('"/files/[...path]": "path";');
    expect(pathMap).toContain('"/files/:path{.+}": RoutePathMap["/files/[...path]"];');
    expect(pathMap).toContain('"/files/[...]": "*";');
    expect(pathMap).toContain('"/files/*": RoutePathMap["/files/[...]"];');
    expect(pathMap).toContain('"/chat/[room]": "room";');
    expect(pathMap).toContain('"/chat/:room": RoutePathMap["/chat/[room]"];');
  });
});
