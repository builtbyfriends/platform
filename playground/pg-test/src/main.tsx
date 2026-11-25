import { fetch } from '@builtbyfriends/bwf/client';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';

const loadUsers = () => fetch('/api/users');
const loadPosts = () => fetch('/api/posts');

function App() {
  const [users, setUsers] = useState<Awaited<ReturnType<typeof loadUsers>>>([]);
  const [posts, setPosts] = useState<Awaited<ReturnType<typeof loadPosts>>>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [authorId, setAuthorId] = useState(0);

  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  useEffect(() => {
    void Promise.all([loadUsers(), loadPosts()]).then(([nextUsers, nextPosts]) => {
      setUsers(nextUsers);
      setPosts(nextPosts);
    });
  }, [version]);

  async function addUser(event: FormEvent) {
    event.preventDefault();
    await fetch('/api/users', { method: 'POST', body: { name, email } });
    setName('');
    setEmail('');
    reload();
  }

  async function addPost(event: FormEvent) {
    event.preventDefault();
    await fetch('/api/posts', { method: 'POST', body: { title, body, authorId } });
    setTitle('');
    setBody('');
    reload();
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 20 }}>
      <h1>Database (PostgreSQL)</h1>
      <p>
        PostgreSQL via <code>bwf/db</code> + Drizzle ORM.
      </p>

      <h2>Add User</h2>
      <form onSubmit={addUser}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          required
        />
        <button type="submit">Add User</button>
      </form>
      <h2>Users ({users.length})</h2>
      <ul>
        {users.map((user) => (
          <li key={user.id}>
            {user.name} ({user.email}){' '}
            <button
              onClick={() =>
                fetch('/api/users/:id', { method: 'DELETE', params: { id: String(user.id) } }).then(
                  reload,
                )
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      <h2>Add Post</h2>
      <form onSubmit={addPost}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Post title"
          required
        />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Post body" />
        <select value={authorId} onChange={(e) => setAuthorId(Number(e.target.value))} required>
          <option value={0} disabled>
            Select author
          </option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
        <button type="submit">Add Post</button>
      </form>
      <h2>Posts ({posts.length})</h2>
      <ul>
        {posts.map((post) => (
          <li key={post.id}>
            {post.title} by {post.author}{' '}
            <button
              onClick={() =>
                fetch('/api/posts/:id', { method: 'DELETE', params: { id: String(post.id) } }).then(
                  reload,
                )
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
