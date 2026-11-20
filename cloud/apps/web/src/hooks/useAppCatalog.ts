import React from 'react';
import { useAction } from 'convex/react';
import { ComposioAppPageSchema, type ComposioApp } from '@praxis/protocol';
import { api } from '../../../../convex/_generated/api';

const CATALOG_SEARCH_DEBOUNCE_MS = 250;

export interface AppCatalog {
  state: 'loading' | 'ready' | 'error';
  items: readonly ComposioApp[];
  totalItems: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

interface CatalogSnapshot {
  state: 'loading' | 'ready' | 'error';
  items: readonly ComposioApp[];
  nextCursor: string | null;
  totalItems: number;
  loadingMore: boolean;
}

const INITIAL_SNAPSHOT: CatalogSnapshot = {
  state: 'loading',
  items: [],
  nextCursor: null,
  totalItems: 0,
  loadingMore: false,
};

function mergeUnique(existing: readonly ComposioApp[], incoming: readonly ComposioApp[]): readonly ComposioApp[] {
  const seen = new Set(existing.map((app) => app.toolkit));
  const extra = incoming.filter((app) => !seen.has(app.toolkit));
  return extra.length ? [...existing, ...extra] : existing;
}

/** Fetches the full Composio toolkit catalog via Convex with debounced search and cursor pagination. */
export function useAppCatalog(query: string): AppCatalog {
  const fetchCatalog = useAction(api.composio.connections.catalog);
  const [snapshot, setSnapshot] = React.useState<CatalogSnapshot>(INITIAL_SNAPSHOT);
  const [attempt, setAttempt] = React.useState(0);
  const requestIdRef = React.useRef(0);
  const loadingMoreRef = React.useRef(false);
  const trimmed = query.trim();

  React.useEffect(() => {
    const requestId = ++requestIdRef.current;
    loadingMoreRef.current = false;
    setSnapshot((prev) => ({
      ...prev,
      state: 'loading',
      loadingMore: false,
    }));

    const run = async () => {
      try {
        const raw: unknown = await fetchCatalog(trimmed ? { search: trimmed } : {});
        if (requestIdRef.current !== requestId) return;
        const parsed = ComposioAppPageSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn('App catalog had an unexpected shape', parsed.error.issues.length);
          setSnapshot({ state: 'error', items: [], nextCursor: null, totalItems: 0, loadingMore: false });
          return;
        }
        setSnapshot({
          state: 'ready',
          items: parsed.data.items,
          nextCursor: parsed.data.nextCursor,
          totalItems: parsed.data.totalItems,
          loadingMore: false,
        });
      } catch {
        if (requestIdRef.current !== requestId) return;
        setSnapshot({ state: 'error', items: [], nextCursor: null, totalItems: 0, loadingMore: false });
      }
    };

    if (!trimmed) {
      void run();
      return;
    }
    const timer = window.setTimeout(() => {
      void run();
    }, CATALOG_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [attempt, fetchCatalog, trimmed]);

  const loadMore = React.useCallback(() => {
    const cursor = snapshot.nextCursor;
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const requestId = requestIdRef.current;
    setSnapshot((prev) => ({ ...prev, loadingMore: true }));
    void (async () => {
      try {
        const raw: unknown = await fetchCatalog(trimmed ? { search: trimmed, cursor } : { cursor });
        if (requestIdRef.current !== requestId) return;
        const parsed = ComposioAppPageSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn('App catalog page had an unexpected shape', parsed.error.issues.length);
          setSnapshot((prev) => ({ ...prev, loadingMore: false }));
          return;
        }
        setSnapshot((prev) => ({
          state: 'ready',
          items: mergeUnique(prev.items, parsed.data.items),
          nextCursor: parsed.data.nextCursor,
          totalItems: parsed.data.totalItems,
          loadingMore: false,
        }));
      } catch {
        if (requestIdRef.current !== requestId) return;
        setSnapshot((prev) => ({ ...prev, loadingMore: false }));
      } finally {
        if (requestIdRef.current === requestId) loadingMoreRef.current = false;
      }
    })();
  }, [fetchCatalog, snapshot.nextCursor, trimmed]);

  const retry = React.useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return {
    state: snapshot.state,
    items: snapshot.items,
    totalItems: snapshot.totalItems,
    hasMore: snapshot.nextCursor !== null,
    loadingMore: snapshot.loadingMore,
    loadMore,
    retry,
  };
}
