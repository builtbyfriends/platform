import { useState } from 'react';
import type { FormEvent } from 'react';

function textFromAiResult(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }

  const result = value as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }>;
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  };

  if (typeof result.response === 'string') {
    return result.response;
  }

  const choice = result.choices?.[0];
  if (typeof choice?.delta?.content === 'string') {
    return choice.delta.content;
  }
  if (typeof choice?.message?.content === 'string') {
    return choice.message.content;
  }

  const parts = result.candidates?.[0]?.content?.parts;
  if (parts) {
    return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
  }

  return '';
}

const models = [
  { value: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B (Workers AI)' },
  { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google)' },
  { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini (OpenAI)' },
  { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Anthropic)' },
];

export default function AiPage() {
  const [selectedModel, setSelectedModel] = useState(models[0].value);
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim()) {
      return;
    }
    setLoading(true);
    setResponse('');
    setError('');

    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, model: selectedModel }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        setError(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
        return;
      }

      if (res.headers.get('content-type')?.includes('application/json')) {
        const parsed = await res.json();
        setResponse(textFromAiResult(parsed) || JSON.stringify(parsed, null, 2));
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let event = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
            continue;
          }
          if (!line.trim()) {
            event = '';
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              if (event === 'platform:error' || event === 'platform:limit') {
                setError(
                  typeof parsed.message === 'string'
                    ? parsed.message
                    : 'Generation was interrupted.',
                );
                await reader.cancel();
                return;
              }
              const text = textFromAiResult(parsed);
              setResponse((current) => current + text);
            } catch {}
          }
        }
      }
    } catch (error_) {
      setError(String(error_));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>AI</h1>
      <p>
        AI inference via <code>bwf/ai</code>.
      </p>

      <h2>Model</h2>
      <select
        value={selectedModel}
        onChange={(e) => setSelectedModel(e.target.value)}
        style={{ fontFamily: 'monospace', padding: 4 }}
      >
        {models.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      <h2>Prompt</h2>
      <form onSubmit={submit}>
        <div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask something..."
            rows={3}
            style={{ width: '100%', fontFamily: 'monospace' }}
          ></textarea>
        </div>
        <button type="submit" disabled={loading} style={{ marginTop: 5 }}>
          {loading ? 'Generating...' : 'Send'}
        </button>
      </form>

      {error && (
        <div style={{ color: 'red', marginTop: 10 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      <h2>Response</h2>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#f5f5f5', padding: 10, minHeight: 60 }}>
        {response || '(waiting for prompt...)'}
      </pre>
    </div>
  );
}
