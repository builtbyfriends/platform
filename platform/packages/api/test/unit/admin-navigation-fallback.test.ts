import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vite-plus/test';
import { AdminNavigationFallback } from '../../src/admin/react/AdminNavigationFallback.tsx';
import { SpaContext } from '../../src/admin/react/spa.tsx';
import type { PageObject } from '../../src/admin/react/spa.tsx';

it('renders the destination skeleton outside the Platform page context', () => {
  const initialPageData: PageObject = {
    component: 'dashboard',
    props: { platformName: 'e2e Platform', username: 'admin' },
    shared: {},
    url: '/admin/',
  };
  const markup = renderToStaticMarkup(
    createElement(
      SpaContext,
      {
        value: {
          page: initialPageData,
          pending: new URL('https://platform.example/admin/users'),
          visit: async () => {},
        },
      },
      createElement(AdminNavigationFallback, { initialPageData }),
    ),
  );

  expect(markup).toContain('Users');
  expect(markup).toContain('Loading users');
  expect(markup).toContain('platform-admin-loading-lines');
});

it('renders the Zero Trust skeleton for client navigation', () => {
  const markup = renderToStaticMarkup(
    createElement(
      SpaContext,
      {
        value: {
          page: { component: 'dashboard', props: {}, shared: {}, url: '/admin/' },
          pending: new URL('https://platform.example/admin/zero-trust'),
          visit: async () => {},
        },
      },
      createElement(AdminNavigationFallback, {
        initialPageData: {
          component: 'dashboard',
          props: { platformName: 'e2e Platform', username: 'admin' },
          shared: {},
          url: '/admin/',
        },
      }),
    ),
  );

  expect(markup).toContain('Loading zero trust');
  expect(markup).toContain('href="/admin/zero-trust"');
});
