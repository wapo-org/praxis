import { ModelSchema, type Model } from './legacy-providers';
import React from 'react';

import { apiClient } from './api';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const key = (m: Pick<Model, 'providerId' | 'id'>) => `${m.providerId}\u0000${m.id}`;

/**
 * Server-backed model catalog. The list never empties while a request is in flight: `seed` is shown
 * until the first page arrives, and the previous results stay up while a new query is loading.
 */
export function useModelSearch(query: string, enabled: boolean, seed?: readonly Model[]) {
  const [items, setItems] = React.useState<Model[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  const seedRef = React.useRef(seed);
  seedRef.current = seed;
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const fetchPage = async (q: string, next: string | undefined, version: number) => {
    setBusy(true);
    setError('');
    try {
      const page = await apiClient.listModels({ q, cursor: next, limit: PAGE_SIZE });
      if (generation.current !== version) return;
      const valid = page.items.flatMap((value) => {
        const result = ModelSchema.safeParse(value);
        return result.success ? [result.data] : [];
      });
      setItems((previous) => {
        if (!next) return valid;
        const seen = new Set(previous.map(key));
        return [...previous, ...valid.filter((m) => !seen.has(key(m)))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      if (generation.current === version)
        setError(err instanceof Error ? err.message : 'Model search unavailable');
    } finally {
      if (generation.current === version) setBusy(false);
    }
  };
  const wasEnabled = React.useRef(false);
  React.useEffect(() => {
    const version = ++generation.current;
    setCursor(null);
    setError('');
    setBusy(enabled);
    if (!enabled) {
      wasEnabled.current = false;
      setItems([]);
      return;
    }
    if (!wasEnabled.current && !query.trim() && seedRef.current?.length) setItems([...seedRef.current]);
    wasEnabled.current = true;
    const q = query.trim();
    // Opening the list fetches right away; only typing is debounced.
    const timer = setTimeout(() => void fetchPage(q, undefined, version), q ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [query, enabled, revision]);
  /** Apply a change to one model in place, so toggling a pin never resets the loaded pages. */
  const patch = React.useCallback((updated: Pick<Model, 'providerId' | 'id'> & Partial<Model>) => {
    setItems((previous) =>
      previous.map((m) => (key(m) === key(updated) ? { ...m, ...updated } : m)),
    );
  }, []);
  return {
    items,
    cursor,
    busy,
    error,
    refresh,
    patch,
    loadMore: () => {
      if (cursor && !busy) void fetchPage(query.trim(), cursor, generation.current);
    },
  };
}
