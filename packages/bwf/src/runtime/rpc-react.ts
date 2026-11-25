import { useCallback, useEffect, useRef, useState } from 'react';
import { RpcError, rpcName } from './rpc.ts';

export { RpcError };

export type CallState<Output> = {
  /** The last successful result. It stays while a refetch runs. */
  data: Output | undefined;
  error: RpcError | undefined;
  /** True until the first result, and again during a refetch. False when the call is disabled. */
  loading: boolean;
  refetch: () => void;
};

export type CallOptions = {
  /** Set to `false` to make no request yet, for example while the input is still loading. */
  enabled?: boolean;
  /**
   * A value that changes when the data may be stale, such as a counter a live stream bumps.
   * Each change calls the procedure again and keeps the current data on screen meanwhile.
   */
  refetchOn?: unknown;
};

type CallArgs<Input> = undefined extends Input
  ? [input?: Input, options?: CallOptions]
  : [input: Input, options?: CallOptions];

function asRpcError(error: unknown): RpcError {
  return error instanceof RpcError ? error : new RpcError('INTERNAL', String(error), 0);
}

/**
 * Calls a procedure when the component mounts and whenever its input changes:
 * `const { data, error, loading } = useCall(rpc.contacts.get, { id })`. It tracks loading
 * state, errors and refetch, and nothing else. Wrap `rpc.*` in a cache if you need one.
 *
 * Pass `{ enabled: false }` to wait, and `{ refetchOn }` to call again when a signal changes.
 */
export function useCall<Input, Output>(
  procedure: (input: Input) => Promise<Output>,
  ...[input, options]: CallArgs<Input>
): CallState<Output> {
  const name = rpcName(procedure);
  if (!name) {
    throw new Error('useCall takes a procedure from `rpc`, such as `rpc.contacts.get`.');
  }
  const enabled = options?.enabled !== false;
  const signal = JSON.stringify(options?.refetchOn ?? null);
  const key = JSON.stringify(input ?? null);
  const latest = useRef(procedure);
  latest.current = procedure;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<CallState<Output>, 'refetch'>>({
    data: undefined,
    error: undefined,
    loading: enabled,
  });

  useEffect(() => {
    if (!enabled) {
      setState((previous) => (previous.loading ? { ...previous, loading: false } : previous));
      return;
    }
    let current = true;
    setState((previous) => (previous.loading ? previous : { ...previous, loading: true }));
    latest.current(JSON.parse(key) ?? undefined).then(
      (data) => current && setState({ data, error: undefined, loading: false }),
      (error: unknown) =>
        current &&
        setState((previous) => ({ ...previous, error: asRpcError(error), loading: false })),
    );
    return () => {
      current = false;
    };
  }, [name, key, attempt, enabled, signal]);

  const refetch = useCallback(() => setAttempt((count) => count + 1), []);
  return { ...state, refetch };
}

/** The answer a paged procedure gives: one page and where the next starts. */
export type Page<Item> = {
  page: ReadonlyArray<Item>;
  isDone: boolean;
  continueCursor: string | null;
};

export type PagesState<Item> = {
  /** Every loaded page in order, with rows that slid between pages listed once. */
  results: Array<Item>;
  /** Loads the next page. Does nothing while one is loading or when there is none. */
  loadMore: () => void;
  canLoadMore: boolean;
  /** True while the first page loads, and again while every page is refetched. */
  loading: boolean;
  loadingMore: boolean;
  error: RpcError | undefined;
  refetch: () => void;
};

export type PagesOptions<Item> = CallOptions & {
  pageSize?: number;
  /** Tells rows apart so one that slides between pages shows once. Defaults to an `id` or `_id` field. */
  getKey?: (item: Item) => string | number;
};

function defaultKey(item: unknown): string | number {
  const row = item as { id?: string | number; _id?: string | number } | null;
  return row?.id ?? row?._id ?? JSON.stringify(item);
}

/**
 * Pages through a procedure that takes `{ cursor, numItems }` and answers
 * `{ page, isDone, continueCursor }`. `loadMore` adds the next page. A refetch (or a
 * `refetchOn` change) asks again for every loaded page from its own start cursor, so a
 * list that grew or shrank stays right, and de-duplicates rows by `getKey`.
 */
export function useCallPages<Input extends { cursor?: string | null; numItems: number }, Item>(
  procedure: (input: Input) => Promise<Page<Item>>,
  input: Omit<Input, 'cursor' | 'numItems'>,
  options: PagesOptions<Item> = {},
): PagesState<Item> {
  const name = rpcName(procedure);
  if (!name) {
    throw new Error('useCallPages takes a procedure from `rpc`, such as `rpc.inbox.list`.');
  }
  const { pageSize = 20, enabled = true, getKey } = options;
  const key = JSON.stringify(input);
  const signal = JSON.stringify(options.refetchOn ?? null);
  const latest = useRef(procedure);
  latest.current = procedure;
  const keyOf = useRef(getKey);
  keyOf.current = getKey;
  const [attempt, setAttempt] = useState(0);
  // Decision: The start cursor of every loaded page. The first is null.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pages, setPages] = useState<Array<Page<Item>>>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<RpcError | undefined>();

  const [inputKey, setInputKey] = useState(key);
  if (inputKey !== key) {
    setInputKey(key);
    setCursors([null]);
    setPages([]);
  }

  const cursorKey = JSON.stringify(cursors);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    const base = JSON.parse(key) as Omit<Input, 'cursor' | 'numItems'>;
    Promise.all(
      (JSON.parse(cursorKey) as Array<string | null>).map((cursor) =>
        latest.current({ ...base, cursor, numItems: pageSize } as Input),
      ),
    ).then(
      (loaded) => {
        if (!current) {
          return;
        }
        setPages(loaded);
        setError(undefined);
        setLoading(false);
      },
      (error_: unknown) => {
        if (!current) {
          return;
        }
        setError(asRpcError(error_));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [name, key, cursorKey, pageSize, enabled, attempt, signal]);

  const last = pages.at(-1);
  const canLoadMore =
    !loading && last !== undefined && !last.isDone && last.continueCursor !== null;
  const loadMore = useCallback(() => {
    if (canLoadMore && last?.continueCursor) {
      setCursors((previous) => [...previous, last.continueCursor]);
    }
  }, [canLoadMore, last]);
  const refetch = useCallback(() => setAttempt((count) => count + 1), []);

  const seen = new Set<string | number>();
  const results: Array<Item> = [];
  for (const page of pages) {
    for (const item of page.page) {
      const id = (keyOf.current ?? defaultKey)(item);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      results.push(item);
    }
  }
  return {
    results,
    loadMore,
    canLoadMore,
    loading: loading && pages.length === 0,
    loadingMore: loading && pages.length > 0,
    error,
    refetch,
  };
}
