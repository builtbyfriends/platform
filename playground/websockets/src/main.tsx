import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import ChatPage from './Chat.tsx';
import NotificationsPage from './Notifications.tsx';

const highlights = [
  {
    title: 'Chat room via defineRoom()',
    body: 'One Durable Object instance per room slug. Broadcast join events, typed messages, and keep per-connection profile state.',
    href: '/chat',
  },
  {
    title: 'Single socket notifications',
    body: 'A single websocket streams notifications over time, supports stop and restart, and sends typed ack events back to the browser.',
    href: '/notifications',
  },
];

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

function HomePage() {
  return (
    <div>
      <h1>WebSocket Playground</h1>
      <p>
        Two focused demos for the <code>bwf/ws</code> surface.
      </p>
      <ul>
        {highlights.map((item) => (
          <li key={item.href}>
            <Link href={item.href}>{item.title}</Link> - {item.body}
          </li>
        ))}
      </ul>
    </div>
  );
}

const pages: Record<string, () => ReactNode> = {
  '/': HomePage,
  '/chat': ChatPage,
  '/notifications': NotificationsPage,
};

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener('popstate', update);
    // Decision: Browser tests wait for this marker before they use the page.
    document.getElementById('app')!.dataset.hydrated = 'true';
    return () => removeEventListener('popstate', update);
  }, []);
  const Page = pages[path] ?? HomePage;
  return (
    <div>
      <nav>
        <Link href="/">Home</Link> | <Link href="/chat">Chat</Link> |{' '}
        <Link href="/notifications">Notifications</Link> | <span>WebSocket Playground</span>
      </nav>
      <hr />
      <Page />
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
