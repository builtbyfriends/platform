import { StrictMode, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { platformPageTitle } from '../lib/platform-title.ts';
import type { Props as AccountProps } from '../server/account.ts';
import type { Props as HomeProps } from '../server/home.ts';
import type { Props as LoginProps } from '../server/login.ts';
import DashboardLayout from './DashboardLayout.tsx';
import Layout from './Layout.tsx';
import AccountPage from './pages/Account.tsx';
import HomePage from './pages/Home.tsx';
import LoginPage from './pages/Login.tsx';

type Page =
  | { id: 'home'; props: HomeProps }
  | { id: 'login'; props: LoginProps }
  | { id: 'account'; props: AccountProps };

const ROUTES: Record<string, Page['id']> = {
  '/': 'home',
  '/login': 'login',
  '/account': 'account',
};
const TITLES: Record<Page['id'], string> = {
  home: 'Dashboard',
  login: 'Sign in',
  account: 'Login methods',
};

async function loadPage(id: Page['id']): Promise<Page | null> {
  const response = await fetch(`/api/page/${id}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) {
    location.replace('/login');
    return null;
  }
  if (!response.ok) {
    throw new Error(`The ${id} page failed to load (${response.status}).`);
  }
  return { id, props: await response.json() } as Page;
}

function render(page: Page): ReactNode {
  switch (page.id) {
    case 'home':
      return (
        <DashboardLayout user={page.props.user}>
          <HomePage {...page.props} />
        </DashboardLayout>
      );
    case 'account':
      return (
        <DashboardLayout user={page.props.user ?? null}>
          <AccountPage {...page.props} />
        </DashboardLayout>
      );
    case 'login':
      return (
        <Layout>
          <LoginPage {...page.props} />
        </Layout>
      );
  }
}

function App() {
  const id = ROUTES[location.pathname];
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      return;
    }
    loadPage(id).then(
      (loaded) => {
        if (loaded) {
          document.title = platformPageTitle(TITLES[loaded.id], loaded.props.platformName);
          setPage(loaded);
        }
      },
      (error_: unknown) => setError(error_ instanceof Error ? error_.message : String(error_)),
    );
  }, [id]);

  if (!id) {
    return (
      <Layout>
        <main className="wrapper dashboard-page">
          <h1>Page not found</h1>
          <a href="/">Back to account</a>
        </main>
      </Layout>
    );
  }
  if (error) {
    return (
      <Layout>
        <main className="wrapper dashboard-page">
          <p>{error}</p>
          <a href={location.pathname}>Try again</a>
        </main>
      </Layout>
    );
  }
  return page ? render(page) : <Layout loading>{null}</Layout>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
