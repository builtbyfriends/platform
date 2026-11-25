import { useState } from 'react';
import type { FormEvent } from 'react';
import { defaultSandboxCode as defaultCode, sampleRequests } from '../lib/sandbox-demo.ts';

const preStyle = {
  whiteSpace: 'pre-wrap',
  background: '#f5f5f5',
  padding: 10,
  minHeight: 60,
} as const;

export default function SandboxPage() {
  const [code, setCode] = useState(defaultCode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const [stdout, setStdout] = useState('');
  const [stderr, setStderr] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  async function runCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    setStdout('');
    setStderr('');
    setExitCode(null);
    setDuration(null);

    try {
      const res = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        message?: string;
        output?: unknown;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        duration?: number;
      };

      if (!res.ok || !body.ok) {
        setError(body.message ?? body.error ?? body.stderr ?? `${res.status} ${res.statusText}`);
      }

      setResult(body.output ?? null);
      setStdout(body.stdout ?? '');
      setStderr(body.stderr ?? '');
      setExitCode(body.exitCode ?? null);
      setDuration(body.duration ?? null);
    } catch (error_) {
      setError(String(error_));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>Sandbox</h1>
      <p>
        Run user-authored JavaScript in an isolated Cloudflare Sandbox. The Worker writes files into{' '}
        <code>/workspace</code>, executes <code>node run.mjs</code>, and reads the result back.
      </p>

      <h2>Sample Edge Requests</h2>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#f5f5f5', padding: 10 }}>
        {JSON.stringify(sampleRequests, null, 2)}
      </pre>

      <h2>Analyzer Code</h2>
      <form onSubmit={runCode}>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={22}
          spellCheck={false}
          style={{ width: '100%', fontFamily: 'monospace' }}
        ></textarea>
        <button type="submit" disabled={loading} style={{ marginTop: 5 }}>
          {loading ? 'Running in sandbox...' : 'Run in Sandbox'}
        </button>
      </form>

      {error && (
        <div style={{ color: 'red', marginTop: 10 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      <h2>Result</h2>
      {exitCode !== null && (
        <p>
          Exit <code>{exitCode}</code>, {duration}ms
        </p>
      )}
      <pre style={preStyle}>{result ? JSON.stringify(result, null, 2) : '(run the analyzer)'}</pre>

      <h2>Process Output</h2>
      <pre style={preStyle}>
        {[stdout, stderr].filter(Boolean).join('\n') || '(no stdout/stderr yet)'}
      </pre>
    </div>
  );
}
