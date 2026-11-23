/** @jsxImportSource react */

import {
  createContext,
  forwardRef,
  startTransition,
  Suspense,
  use,
  useContext,
  useEffect,
  useState,
} from 'react';
import type {
  AnchorHTMLAttributes,
  ComponentType,
  ElementType,
  MouseEvent,
  ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';

export type PageObject = {
  component: string;
  props: Record<string, unknown>;
  shared: Record<string, unknown>;
  url: string;
  head?: { title?: string };
};

type Loader = () => Promise<{ default: ElementType }>;

type Spa = {
  page: PageObject;
  pending: URL | null;
  visit: (href: string, options?: { replace?: boolean }) => Promise<void>;
};

export const SpaContext = createContext<Spa | null>(null);

function useSpa(): Spa {
  const spa = useContext(SpaContext);
  if (!spa) {
    throw new Error('Admin SPA hooks must be used inside startAdminSpa().');
  }
  return spa;
}

export function useShared<T>(): T {
  return useSpa().page.shared as T;
}

export function useRouter() {
  const { page, visit } = useSpa();
  return { path: new URL(page.url, 'https://platform.invalid').pathname, visit };
}

export function useNavigation() {
  return { location: useSpa().pending };
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export const Link = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { reloadDocument?: boolean }
>(function Link({ onClick, reloadDocument, ...props }, ref) {
  const spa = useContext(SpaContext);
  return (
    <a
      ref={ref}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        const href = props.href;
        if (
          !spa ||
          reloadDocument ||
          !href ||
          props.target ||
          props.download ||
          !isPlainLeftClick(event)
        ) {
          return;
        }
        const url = new URL(href, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/admin')) {
          return;
        }
        event.preventDefault();
        void spa.visit(url.pathname + url.search + url.hash);
      }}
    />
  );
});

/** Reads the page object the server embedded in the shell. */
function readEmbeddedPage(): PageObject {
  const element = document.getElementById('platform-admin-page');
  return JSON.parse(element?.textContent ?? '{}') as PageObject;
}

async function fetchPage(href: string): Promise<{ page: PageObject; url: string } | null> {
  const response = await fetch(href, {
    credentials: 'same-origin',
    headers: { 'X-PlatformPages': 'true', Accept: 'application/json' },
  });
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    return null;
  }
  return { page: (await response.json()) as PageObject, url: response.url };
}

const componentCache = new Map<string, Promise<{ default: ElementType }>>();

function loadComponent(components: Record<string, Loader>, id: string) {
  let promise = componentCache.get(id);
  if (!promise) {
    const loader = components[id];
    if (!loader) {
      throw new Error(`Unknown admin page component "${id}".`);
    }
    promise = loader();
    // Decision: Record the result on the promise so `use()` reads a loaded module without suspending.
    const tracked = promise as typeof promise & { status?: string; value?: unknown };
    void promise.then((value) => {
      tracked.status = 'fulfilled';
      tracked.value = value;
    });
    componentCache.set(id, promise);
  }
  return promise;
}

function PageBody({ components, page }: { components: Record<string, Loader>; page: PageObject }) {
  const Page = use(loadComponent(components, page.component)).default;
  useEffect(() => {
    // Decision: Set once the page itself has rendered (after any data it suspends on); browser tests wait
    // for it before interacting.
    document.getElementById('platform-admin-root')?.setAttribute('data-hydrated', 'true');
  }, []);
  return <Page {...page.props} />;
}

/**
 * Layouts stay mounted across navigations (they own client state such as the data client); only
 * the page below them suspends or shows the loading view.
 */
export function PageView({
  components,
  layoutTree,
  page,
  loading,
  fallback = null,
}: {
  components: Record<string, Loader>;
  layoutTree: Record<string, Array<string>>;
  page: PageObject;
  loading?: boolean;
  fallback?: ReactNode;
}) {
  const layouts = (layoutTree[page.component] ?? []).map(
    (id) => use(loadComponent(components, id)).default,
  );
  return layouts.reduceRight<ReactNode>(
    (children, Layout) => <Layout>{children}</Layout>,
    <Suspense fallback={fallback}>
      {loading ? fallback : <PageBody key={page.url} components={components} page={page} />}
    </Suspense>,
  );
}

export function startAdminSpa(options: {
  components: Record<string, Loader>;
  layoutTree: Record<string, Array<string>>;
  navigationFallback: ComponentType<{ initialPageData: PageObject }>;
}) {
  const initial = readEmbeddedPage();
  const Fallback = options.navigationFallback;

  function App() {
    const [page, setPage] = useState(initial);
    const [pending, setPending] = useState<URL | null>(null);

    const show = (next: PageObject) => {
      if (next.head?.title) {
        document.title = next.head.title;
      }
      startTransition(() => setPage(next));
    };

    const visit: Spa['visit'] = async (href, { replace = false } = {}) => {
      const target = new URL(href, location.href);
      setPending(target);
      try {
        const result = await fetchPage(target.href);
        if (!result) {
          location.assign(target.href);
          return;
        }
        const finalUrl = new URL(result.url || target.href);
        const path = finalUrl.pathname + finalUrl.search + target.hash;
        history[replace ? 'replaceState' : 'pushState'](null, '', path);
        show(result.page);
        if (!target.hash) {
          scrollTo(0, 0);
        }
      } catch {
        location.assign(target.href);
      } finally {
        setPending(null);
      }
    };

    useEffect(() => {
      const onPopState = () => {
        void fetchPage(location.href).then((result) =>
          result ? show(result.page) : location.reload(),
        );
      };
      addEventListener('popstate', onPopState);
      return () => removeEventListener('popstate', onPopState);
    }, []);

    return (
      <SpaContext value={{ page, pending, visit }}>
        <Suspense fallback={<Fallback initialPageData={page} />}>
          <PageView
            components={options.components}
            layoutTree={options.layoutTree}
            page={page}
            loading={pending !== null}
            fallback={<Fallback initialPageData={page} />}
          />
        </Suspense>
      </SpaContext>
    );
  }

  // Decision: Load the first page's code before rendering so a full page load doesn't flash the loading
  // view.
  const firstCode = [initial.component, ...(options.layoutTree[initial.component] ?? [])].map(
    (id) => loadComponent(options.components, id),
  );
  void Promise.allSettled(firstCode).then(() =>
    createRoot(document.getElementById('platform-admin-root')!).render(<App />),
  );
}
