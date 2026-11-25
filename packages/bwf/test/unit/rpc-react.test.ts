// @vitest-environment happy-dom
import { createElement, useEffect } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vite-plus/test';
import { useCall, useCallPages } from '../../src/runtime/rpc-react.ts';
import type { CallOptions, PagesState } from '../../src/runtime/rpc-react.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function procedure<Input, Output>(name: string, impl: (input: Input) => Promise<Output>) {
  const fn = vi.fn(impl);
  return Object.assign(fn, { [Symbol.for('bwf.rpc.name')]: name });
}

async function mount<T>(use: () => T) {
  const seen: { current: T | undefined } = { current: undefined };
  function Probe() {
    const value = use();
    useEffect(() => {
      seen.current = value;
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  return {
    get value() {
      return seen.current as T;
    },
    rerender: (next: () => T) =>
      act(async () => {
        function Next() {
          const value = next();
          useEffect(() => {
            seen.current = value;
          });
          return null;
        }
        root.render(createElement(Next));
      }),
    unmount: () => act(async () => root.unmount()),
  };
}

describe('useCall', () => {
  it('calls once and reports the answer', async () => {
    const get = procedure('x.get', async (input: { id: string }) => `got ${input.id}`);
    const view = await mount(() => useCall(get, { id: 'a' }));
    expect(view.value.data).toBe('got a');
    expect(view.value.loading).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('makes no request while disabled and reports not loading', async () => {
    const get = procedure('x.get', async (_input: { id: string }) => 'never');
    const view = await mount(() => useCall(get, { id: 'a' }, { enabled: false }));
    expect(get).not.toHaveBeenCalled();
    expect(view.value.loading).toBe(false);
    expect(view.value.data).toBeUndefined();
  });

  it('calls again when refetchOn changes and keeps the data meanwhile', async () => {
    let n = 0;
    const get = procedure('x.get', async (_input: { id: string }) => ++n);
    let options: CallOptions = { refetchOn: 1 };
    const view = await mount(() => useCall(get, { id: 'a' }, options));
    expect(view.value.data).toBe(1);
    options = { refetchOn: 2 };
    await view.rerender(() => useCall(get, { id: 'a' }, options));
    expect(get).toHaveBeenCalledTimes(2);
    expect(view.value.data).toBe(2);
  });
});

describe('useCallPages', () => {
  type Row = { id: string };
  const rows: Array<Row> = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  const list = procedure('x.list', async (input: { cursor?: string | null; numItems: number }) => {
    const start = input.cursor ? Number(input.cursor) : 0;
    const end = start + input.numItems;
    return {
      page: rows.slice(start, end),
      isDone: end >= rows.length,
      continueCursor: String(end),
    };
  });

  it('loads a page, then the next on loadMore', async () => {
    const view = await mount(() => useCallPages(list, {}, { pageSize: 2 }));
    expect(view.value.results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(view.value.canLoadMore).toBe(true);
    await act(async () => view.value.loadMore());
    expect(view.value.results.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    await act(async () => view.value.loadMore());
    expect(view.value.results).toHaveLength(5);
    expect(view.value.canLoadMore).toBe(false);
  });

  it('lists a row that slid between pages once', async () => {
    const slide = procedure(
      'x.slide',
      async (input: { cursor?: string | null; numItems: number }) =>
        input.cursor
          ? { page: [{ id: 'b' }, { id: 'c' }], isDone: true, continueCursor: '9' }
          : { page: [{ id: 'a' }, { id: 'b' }], isDone: false, continueCursor: '2' },
    );
    const view = await mount(() => useCallPages(slide, {}, { pageSize: 2 }));
    await act(async () => view.value.loadMore());
    expect((view.value as PagesState<Row>).results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('refetches every loaded page', async () => {
    const calls = vi.fn();
    const counted = procedure(
      'x.count',
      async (input: { cursor?: string | null; numItems: number }) => {
        calls(input.cursor ?? null);
        return {
          page: [{ id: String(input.cursor ?? 'first') }],
          isDone: !!input.cursor,
          continueCursor: '1',
        };
      },
    );
    const view = await mount(() => useCallPages(counted, {}, { pageSize: 1 }));
    await act(async () => view.value.loadMore());
    calls.mockClear();
    await act(async () => view.value.refetch());
    expect(calls.mock.calls.map((c) => c[0])).toEqual([null, '1']);
  });

  it('makes no request while disabled', async () => {
    const get = procedure(
      'x.off',
      async (_input: { cursor?: string | null; numItems: number }) => ({
        page: [],
        isDone: true,
        continueCursor: null,
      }),
    );
    const view = await mount(() => useCallPages(get, {}, { enabled: false }));
    expect(get).not.toHaveBeenCalled();
    expect(view.value.loading).toBe(false);
  });
});
