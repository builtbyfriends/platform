import { auth, fetch as bwfFetch } from '@builtbyfriends/bwf/client';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { ComponentType, FormEvent, ReactNode } from 'react';

const sections: Record<string, () => ReactNode> = {
  '/': Home,
  '/db': Db,
  '/kv': Kv,
  '/storage': Storage,
  '/ai': lazyPage(lazy(() => import('./Ai.tsx'))),
  '/sandbox': lazyPage(lazy(() => import('./Sandbox.tsx'))),
  '/cron': Cron,
  '/queues': Queues,
  '/env': Env,
  '/auth': Auth,
};

function lazyPage(Page: ComponentType) {
  return () => (
    <Suspense fallback={<p>Loading...</p>}>
      <Page />
    </Suspense>
  );
}

function useApi<T>(path: string, initial: T): [T, () => void] {
  const [data, setData] = useState(initial);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    globalThis
      .fetch(path)
      .then((res) => res.json() as Promise<T>)
      .then(setData);
  }, [path, version]);
  return [data, () => setVersion((v) => v + 1)];
}

async function post(path: string, body: unknown, method = 'POST') {
  await globalThis.fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        history.pushState(null, '', href);
        dispatchEvent(new PopStateEvent('popstate'));
      }}
    >
      {children}
    </a>
  );
}

export default function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener('popstate', update);
    // Decision: The hosted smoke test waits for this marker before it uses the page.
    document.getElementById('app')!.dataset.hydrated = 'true';
    return () => removeEventListener('popstate', update);
  }, []);
  const Section = sections[path] ?? NotFound;
  return (
    <div style={{ fontFamily: 'monospace', maxWidth: 800, margin: '0 auto', padding: 20 }}>
      <nav style={{ paddingBottom: 10, marginBottom: 20, borderBottom: '1px solid #ccc' }}>
        <strong>Kitchen Sink</strong> &mdash; <Link href="/">Home</Link> |{' '}
        <Link href="/db">DB</Link> | <Link href="/kv">KV</Link> |{' '}
        <Link href="/storage">Storage</Link> | <Link href="/ai">AI</Link> |{' '}
        <Link href="/sandbox">Sandbox</Link> | <Link href="/cron">Cron</Link> |{' '}
        <Link href="/queues">Queues</Link> | <Link href="/env">Env</Link> |{' '}
        <Link href="/auth">Auth</Link>
      </nav>
      <Section />
    </div>
  );
}

function NotFound() {
  return <h1>Not found</h1>;
}

function Home() {
  return (
    <div>
      <h1>Kitchen Sink</h1>
      <p>A React SPA whose backend in routes/ exercises every major platform feature.</p>
      <ul>
        {Object.keys(sections)
          .filter((path) => path !== '/')
          .map((path) => (
            <li key={path}>
              <Link href={path}>{path.slice(1)}</Link>
            </li>
          ))}
      </ul>
    </div>
  );
}

function Db() {
  const [notes, reload] = useApi<Awaited<ReturnType<typeof listNotes>>>('/api/notes', []);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  async function add(event: FormEvent) {
    event.preventDefault();
    await bwfFetch('/api/notes', { method: 'POST', body: { title, body } });
    setTitle('');
    setBody('');
    reload();
  }

  return (
    <div>
      <h1>DB (D1)</h1>
      <form onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Note title" />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Note body" />
        <button type="submit">Add Note</button>
      </form>
      <h2>Notes ({notes.length})</h2>
      <table>
        <tbody>
          {notes.map((note) => (
            <tr key={note.id}>
              <td>{note.title}</td>
              <td>{note.body}</td>
              <td>
                <button
                  onClick={() =>
                    bwfFetch('/api/notes/:id', {
                      method: 'DELETE',
                      params: { id: String(note.id) },
                    }).then(reload)
                  }
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const listNotes = () => bwfFetch('/api/notes');

function Kv() {
  const lookup = new URLSearchParams(location.search).get('lookup');
  const [data, reload] = useApi<{
    keys: Array<{ name: string }>;
    lookedUp: { key: string; value: string | null } | null;
  }>(lookup ? `/api/kv?lookup=${encodeURIComponent(lookup)}` : '/api/kv', {
    keys: [],
    lookedUp: null,
  });
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  async function set(event: FormEvent) {
    event.preventDefault();
    await post('/api/kv', { intent: 'set', key, value });
    setKey('');
    setValue('');
    reload();
  }

  return (
    <div>
      <h1>KV</h1>
      <form onSubmit={set}>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="my-key" />
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="my-value" />
        <button type="submit">Set</button>
      </form>
      {data.lookedUp && (
        <p>
          {data.lookedUp.key} = {data.lookedUp.value ?? '(not found)'}
        </p>
      )}
      <table>
        <tbody>
          {data.keys.map((k) => (
            <tr key={k.name}>
              <td>
                <a href={`/kv?lookup=${encodeURIComponent(k.name)}`}>{k.name}</a>
              </td>
              <td>
                <button
                  onClick={() => post('/api/kv', { intent: 'delete', key: k.name }).then(reload)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Storage() {
  const [objects, reload] = useApi<Array<{ key: string; size: number }>>('/api/storage', []);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    await globalThis.fetch('/api/storage', { method: 'POST', body: new FormData(form) });
    form.reset();
    reload();
  }

  return (
    <div>
      <h1>Storage (R2)</h1>
      <form onSubmit={upload}>
        <input type="file" name="file" />
        <button type="submit">Upload</button>
      </form>
      <table>
        <tbody>
          {objects.map((obj) => (
            <tr key={obj.key}>
              <td>{obj.key}</td>
              <td>{obj.size} bytes</td>
              <td>
                <button
                  onClick={() =>
                    globalThis
                      .fetch(`/api/storage?key=${encodeURIComponent(obj.key)}`, {
                        method: 'DELETE',
                      })
                      .then(reload)
                  }
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cron() {
  const [data] = useApi<{ lastHeartbeat: string | null }>('/api/cron', { lastHeartbeat: null });
  return (
    <div>
      <h1>Cron</h1>
      <h2>Last Heartbeat</h2>
      <p>
        <code>{data.lastHeartbeat ?? ''}</code>
      </p>
    </div>
  );
}

function Queues() {
  const [results, reload] = useApi<Array<{ id: number; key: string; value: string }>>(
    '/api/queues',
    [],
  );
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  async function send(event: FormEvent) {
    event.preventDefault();
    await post('/api/queues', { key, value });
    setKey('');
    setValue('');
    reload();
  }

  return (
    <div>
      <h1>Queues</h1>
      <form onSubmit={send}>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="my-key" />
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="my-value" />
        <button type="submit">Send to Queue</button>
      </form>
      <table>
        <tbody>
          {results.map((result) => (
            <tr key={result.id}>
              <td>{result.key}</td>
              <td>{result.value}</td>
              <td>
                <button
                  onClick={() =>
                    post('/api/queues', { intent: 'delete', id: result.id }).then(reload)
                  }
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Env() {
  const [bindings] = useApi<Array<{ name: string; type: string }>>('/api/env', []);
  return (
    <div>
      <h1>Env</h1>
      <ul>
        {bindings.map((binding) => (
          <li key={binding.name}>
            {binding.name}: {binding.type}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Auth() {
  const [data, reload] = useApi<{ user: { email?: string; name?: string } | null }>(
    '/api/session',
    { user: null },
  );
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [response, setResponse] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result =
      tab === 'register'
        ? await auth.signUp.email({ email, password, name })
        : await auth.signIn.email({ email, password });
    setResponse(JSON.stringify(result, null, 2));
    setEmail('');
    setPassword('');
    setName('');
    reload();
  }

  async function profile() {
    const res = await globalThis.fetch('/api/profile');
    setResponse(`GET /api/profile (${res.status}):\n${JSON.stringify(await res.json(), null, 2)}`);
  }

  return (
    <div>
      <h1>Auth</h1>
      <p>
        {data.user ? (
          <>
            {data.user.name} ({data.user.email}){' '}
            <button onClick={() => auth.signOut().then(reload)}>Logout</button>
          </>
        ) : (
          'Not logged in'
        )}
      </p>
      <button onClick={() => setTab('login')}>Login</button>
      <button onClick={() => setTab('register')}>Register</button>
      <section>
        <h2>{tab === 'register' ? 'Email Register' : 'Email Login'}</h2>
        <form onSubmit={submit}>
          {tab === 'register' && (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
          <button type="submit">Submit</button>
        </form>
      </section>
      <button onClick={profile}>GET /api/profile</button>
      <pre>{response}</pre>
    </div>
  );
}
