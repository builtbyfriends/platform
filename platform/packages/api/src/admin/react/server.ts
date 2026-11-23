import type { Context } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { formatPlatformPageTitle } from '../../platform-identity.ts';
import type { createAdminFateClient } from '../fate/client.ts';
import type { AdminPageId } from './pages.ts';
import type { PageObject } from './spa.tsx';

export async function renderAdminPage(
  context: Context<ApiEnv>,
  component: AdminPageId,
  title: string,
  props: Record<string, unknown>,
  options: {
    status?: number;
    fateSnapshot?: Parameters<ReturnType<typeof createAdminFateClient>['hydrate']>[0];
  } = {},
): Promise<Response> {
  const platformName = String(props.platformName ?? 'Platform');
  const { pathname, search } = new URL(context.req.url);
  const pageObj: PageObject = {
    component,
    props,
    shared: {
      platformName,
      adminPageUrl: pathname + search,
      adminFateSession: `${context.get('user')?.id ?? 'guest'}:${context.get('humanSession')?.id ?? 'none'}`,
      ...(options.fateSnapshot ? { adminFateSnapshot: options.fateSnapshot } : {}),
    },
    url: pathname + search,
    head: {
      title: formatPlatformPageTitle(title, platformName),
    },
  };
  const headers = {
    'Cache-Control': 'private, no-store',
    Vary: 'X-PlatformPages',
    'X-PlatformPages': 'true',
  };
  if (context.req.header('X-PlatformPages') === 'true') {
    return Response.json(pageObj, { headers, status: options.status ?? 200 });
  }
  const json = JSON.stringify(pageObj).replaceAll('<', String.raw`\u003c`);
  const htmlTitle = escapeHtml(pageObj.head?.title ?? platformName);
  const html = `<!doctype html><html lang="en" data-astryx-theme="neutral"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlTitle}</title><link rel="stylesheet" href="/admin/style.css"></head><body><div id="platform-admin-root"></div><script type="application/json" id="platform-admin-page">${json}</script><script src="/admin/client.js" defer></script></body></html>`;
  return new Response(html, {
    status: options.status ?? 200,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}
