import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  isRestartTokenValid,
  renderRestartingPage,
  restartPlugin,
  sanitizeReturnPath,
} from '../../src/plugin-restart.ts';

type NodeHandler = (req: unknown, res: unknown, next: () => void) => void;

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function createFakeViteServer(plugin: Plugin = restartPlugin()) {
  const stack: Array<{ route: string; handle: NodeHandler }> = [];
  const restart = vi.fn();
  const server = {
    restart,
    middlewares: {
      use(route: string, handle: NodeHandler) {
        stack.push({ route, handle });
      },
    },
  };
  (plugin.configureServer as (this: unknown, s: unknown) => void).call(plugin, server);
  const token = tokenOf(loadClientModule(plugin));

  function dispatch(
    method: string,
    url: string,
    headers: Record<string, string> = {},
    encrypted = false,
    rawUrl?: string,
  ): FakeResponse {
    const parsed = new URL(url, 'http://localhost:5173');
    const entry = stack.find((s) => parsed.pathname === s.route);
    if (!entry) {
      throw new Error(`no middleware for ${parsed.pathname}`);
    }
    const req = {
      method,
      // Decision: connect strips the mounted prefix from req.url.
      url: rawUrl ?? '/' + parsed.search,
      headers: { host: 'localhost:5173', ...headers },
      socket: { encrypted },
    };
    const out: FakeResponse = { status: 200, headers: {}, body: '' };
    const res = {
      writeHead(code: number, h?: Record<string, string>) {
        out.status = code;
        Object.assign(out.headers, h);
      },
      end(chunk?: string) {
        out.body = chunk ?? '';
      },
    };
    entry.handle(req, res, () => {
      throw new Error('unexpected next()');
    });
    return out;
  }

  return { dispatch, restart, token, plugin };
}

function loadClientModule(plugin: Plugin): string {
  const load = plugin.load as { handler: () => string };
  return load.handler();
}

function tokenOf(clientModule: string): string {
  const match = /const token = (".*?");\n/.exec(clientModule);
  if (!match) {
    throw new Error('no token in client module');
  }
  return JSON.parse(match[1]) as string;
}

function pageTokenOf(html: string): string {
  const match = /var token=(.*?);\n/.exec(html);
  if (!match) {
    throw new Error('no token in restarting page');
  }
  return JSON.parse(match[1]) as string;
}

function targetOf(html: string): string {
  const match = /var target=(.*?);\n/.exec(html);
  if (!match) {
    throw new Error('no target in restarting page');
  }
  return JSON.parse(match[1]) as string;
}

describe('sanitizeReturnPath', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.com',
    '//evil.com/path',
    String.raw`/\evil.com`,
    'https://evil.com',
    'http://localhost:5173/',
    'evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/foo\u0000',
    '',
  ])('rejects %j', (value) => {
    expect(sanitizeReturnPath(value)).toBe('/');
  });

  it('falls back to / when the value is missing', () => {
    expect(sanitizeReturnPath(null)).toBe('/');
    expect(sanitizeReturnPath(undefined)).toBe('/');
  });

  it.each(['/', '/foo?x=1', '/a/b#c', '/search?q=%2F%2Fevil.com'])('accepts %j', (value) => {
    expect(sanitizeReturnPath(value)).toBe(value);
  });
});

describe('renderRestartingPage', () => {
  it('embeds the return path so it cannot close the script or break the string', () => {
    const html = renderRestartingPage('/x?a="</script><script>alert(1)</script>', null);
    expect(html).not.toContain('</script><script>alert(1)');
    expect(targetOf(html)).toBe('/x?a="</script><script>alert(1)</script>');
  });

  it('embeds the token so it cannot close the script or break the string', () => {
    const html = renderRestartingPage('/', '"</script><script>alert(1)</script>');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(pageTokenOf(html)).toBe('"</script><script>alert(1)</script>');
    expect(html).toContain('"x-platform-restart":token');
  });

  it('no longer reads the return value from location in the client', () => {
    expect(renderRestartingPage('/', null)).not.toContain('location.search');
  });
});

describe('isRestartTokenValid', () => {
  it('accepts only the exact token', () => {
    expect(isRestartTokenValid('abc', 'abc')).toBe(true);
    expect(isRestartTokenValid('abd', 'abc')).toBe(false);
    expect(isRestartTokenValid('ab', 'abc')).toBe(false);
    expect(isRestartTokenValid(undefined, 'abc')).toBe(false);
    expect(isRestartTokenValid(['abc'], 'abc')).toBe(false);
  });

  it('never matches before a token exists', () => {
    expect(isRestartTokenValid('', '')).toBe(false);
  });
});

describe('restartPlugin middlewares', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['javascript:alert(document.domain)', '//evil.com'])(
    'GET /__platform/restarting?return=%s navigates to /',
    (value) => {
      const { dispatch } = createFakeViteServer();
      const res = dispatch('GET', `/__platform/restarting?return=${encodeURIComponent(value)}`);
      expect(res.status).toBe(200);
      expect(targetOf(res.body)).toBe('/');
    },
  );

  it('GET /__platform/restarting keeps the token out of the return path and the referrer', () => {
    const { dispatch, token } = createFakeViteServer();
    const res = dispatch(
      'GET',
      `/__platform/restarting?return=${encodeURIComponent('/foo?x=1')}&t=${token}`,
    );
    expect(targetOf(res.body)).toBe('/foo?x=1');
    expect(pageTokenOf(res.body)).toBe(token);
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('the toast navigates to /__platform/restarting with the server token', () => {
    const { plugin, token } = createFakeViteServer();
    expect(token).toMatch(/^[\w-]{22}$/);
    expect(loadClientModule(plugin)).toContain(
      '"/__platform/restarting?return=" + encodeURIComponent(location.pathname + location.search) + "&t=" + encodeURIComponent(token)',
    );
  });

  // Decision: Plain-HTTP LAN origins (`bwf dev --host`) get no Fetch Metadata, so a foreign page can
  // navigate here and the page's POST carries our Origin.
  it('does not restart from a foreign navigation without Fetch Metadata', () => {
    vi.useFakeTimers();
    const { dispatch, restart } = createFakeViteServer();
    const page = dispatch('GET', '/__platform/restarting?return=%2F');
    expect(page.status).toBe(200);
    const res = dispatch('POST', '/__platform/restart', {
      origin: 'http://localhost:5173',
      'x-platform-restart': pageTokenOf(page.body),
    });
    expect(res.status).toBe(403);
    vi.runAllTimers();
    expect(restart).not.toHaveBeenCalled();
    expect(dispatch('GET', '/__platform/ping').status).toBe(200);
  });

  it('restarts from the toast navigation without Fetch Metadata', () => {
    vi.useFakeTimers();
    const { dispatch, restart, token } = createFakeViteServer();
    const page = dispatch(
      'GET',
      `/__platform/restarting?return=%2F&t=${encodeURIComponent(token)}`,
    );
    const res = dispatch('POST', '/__platform/restart', {
      origin: 'http://localhost:5173',
      'x-platform-restart': pageTokenOf(page.body),
    });
    expect(res.status).toBe(200);
    vi.runAllTimers();
    expect(restart).toHaveBeenCalledOnce();
  });

  it.each([
    ['no token', {}],
    ['a wrong token', { 'x-platform-restart': 'wrong' }],
  ])('rejects a same-origin POST /__platform/restart with %s', (_label, headers) => {
    vi.useFakeTimers();
    const { dispatch, restart } = createFakeViteServer();
    const res = dispatch('POST', '/__platform/restart', {
      'sec-fetch-site': 'same-origin',
      origin: 'http://localhost:5173',
      ...headers,
    });
    expect(res.status).toBe(403);
    vi.runAllTimers();
    expect(restart).not.toHaveBeenCalled();
  });

  it('gives each server instance a new token', () => {
    vi.useFakeTimers();
    const first = createFakeViteServer();
    // Decision: `server.restart()` runs configureServer again for the new instance.
    const second = createFakeViteServer(first.plugin);
    expect(second.token).not.toBe(first.token);
    expect(tokenOf(loadClientModule(first.plugin))).toBe(second.token);
    expect(
      second.dispatch('POST', '/__platform/restart', { 'x-platform-restart': first.token }).status,
    ).toBe(403);
    expect(
      second.dispatch('POST', '/__platform/restart', { 'x-platform-restart': second.token }).status,
    ).toBe(200);
    // Decision: A restart that failed leaves the old instance checking its own token.
    expect(
      first.dispatch('POST', '/__platform/restart', { 'x-platform-restart': first.token }).status,
    ).toBe(200);
  });

  it.each(['cross-site', 'same-site'])(
    'refuses GET /__platform/restarting with Sec-Fetch-Site: %s',
    (site) => {
      const { dispatch } = createFakeViteServer();
      const res = dispatch('GET', '/__platform/restarting?return=%2Ffoo', {
        'sec-fetch-site': site,
      });
      expect(res.status).toBe(403);
      expect(res.headers['Content-Type']).toBe('text/plain');
      expect(res.body).not.toContain('var target=');
      expect(res.body).not.toContain('fetch("/__platform/restart"');
    },
  );

  it.each([
    ['Sec-Fetch-Site: same-origin', { 'sec-fetch-site': 'same-origin' }],
    ['Sec-Fetch-Site: none', { 'sec-fetch-site': 'none' }],
    ['no Sec-Fetch-Site', {}],
  ])('serves GET /__platform/restarting with %s', (_label, headers) => {
    const { dispatch } = createFakeViteServer();
    const res = dispatch('GET', '/__platform/restarting?return=%2Ffoo', headers);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(targetOf(res.body)).toBe('/foo');
  });

  it('serves GET /__platform/restarting with a request url that does not parse', () => {
    const { dispatch } = createFakeViteServer();
    const res = dispatch('GET', '/__platform/restarting', {}, false, '//[');
    expect(res.status).toBe(200);
    expect(targetOf(res.body)).toBe('/');
  });

  it.each([
    ['cross-site Sec-Fetch-Site', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' }],
    [
      'same-site Sec-Fetch-Site',
      { 'sec-fetch-site': 'same-site', origin: 'http://localhost:3000' },
    ],
    ['a foreign Origin', { origin: 'https://evil.com' }],
    ['a different port', { origin: 'http://localhost:3000' }],
    ['a different scheme', { origin: 'https://localhost:5173' }],
    ['a null Origin', { origin: 'null' }],
  ])('rejects a POST /__platform/restart with %s', (_label, headers) => {
    vi.useFakeTimers();
    const { dispatch, restart, token } = createFakeViteServer();
    const res = dispatch('POST', '/__platform/restart', {
      ...headers,
      'x-platform-restart': token,
    });
    expect(res.status).toBe(403);
    vi.runAllTimers();
    expect(restart).not.toHaveBeenCalled();
    expect(dispatch('GET', '/__platform/ping').status).toBe(200);
  });

  it.each([
    [
      'same-origin Sec-Fetch-Site',
      { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5173' },
    ],
    ['a matching Origin', { origin: 'http://localhost:5173' }],
    ['no browser origin headers', {}],
  ])('accepts a POST /__platform/restart with the token and %s', (_label, headers) => {
    vi.useFakeTimers();
    const { dispatch, restart, token } = createFakeViteServer();
    const res = dispatch('POST', '/__platform/restart', {
      ...headers,
      'x-platform-restart': token,
    });
    expect(res.status).toBe(200);
    expect(dispatch('GET', '/__platform/ping').status).toBe(503);
    vi.runAllTimers();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('matches the Origin scheme against an HTTPS dev server', () => {
    vi.useFakeTimers();
    const { dispatch, token } = createFakeViteServer();
    expect(
      dispatch(
        'POST',
        '/__platform/restart',
        { origin: 'https://localhost:5173', 'x-platform-restart': token },
        true,
      ).status,
    ).toBe(200);
  });

  it('still answers 405 to a non-POST /__platform/restart', () => {
    const { dispatch } = createFakeViteServer();
    expect(dispatch('GET', '/__platform/restart').status).toBe(405);
  });
});
