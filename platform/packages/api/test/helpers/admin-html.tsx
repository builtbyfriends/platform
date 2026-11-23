/** @jsxImportSource react */

import { Suspense } from 'react';
import { prerender } from 'react-dom/static';
import { adminComponents, adminLayoutTree } from '../../src/admin/react/pages.ts';
import { PageView, SpaContext } from '../../src/admin/react/spa.tsx';
import type { PageObject } from '../../src/admin/react/spa.tsx';

// Decision: For an admin SPA shell, append the markup the browser renders from the embedded page object, so
// tests can assert on what the admin sees.
export async function adminHtml(response: Response): Promise<string> {
  const html = await response.text();
  const match = html.match(
    /<script type="application\/json" id="platform-admin-page">([\s\S]*?)<\/script>/,
  );
  if (!match) {
    return html;
  }
  const page = JSON.parse(match[1]!) as PageObject;
  const { prelude } = await prerender(
    <SpaContext value={{ page, pending: null, visit: async () => {} }}>
      <Suspense>
        <PageView components={adminComponents} layoutTree={adminLayoutTree} page={page} />
      </Suspense>
    </SpaContext>,
  );
  // Decision: `<div id="app">` marks where the rendered page starts; tests rely on it.
  return `${html}<div id="app">${await new Response(prelude).text()}</div>`;
}
