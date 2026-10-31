import React from 'react';
import { ModelSchema, type Model } from '@praxis/protocol';
import { apiClient } from './api';

export function useModelSearch(query: string, enabled: boolean) {
  const [items, setItems] = React.useState<Model[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  const [revision, refresh] = React.useReducer(n => n + 1, 0);
  const fetchPage = async (q: string, next: string | undefined, version: number) => {
    setBusy(true); setError('');
    try {
      const page = await apiClient.listModels({ q, cursor: next, limit: 50 });
      if (generation.current !== version) return;
      const valid = page.items.flatMap(value => { const result = ModelSchema.safeParse(value); return result.success ? [result.data] : []; });
      setItems(previous => next ? [...previous, ...valid.filter(m => !previous.some(p => p.id === m.id && p.providerId === m.providerId))] : valid);
      setCursor(page.nextCursor);
    } catch (err) {
      if (generation.current === version) setError(err instanceof Error ? err.message : 'Model search unavailable');
    } finally { if (generation.current === version) setBusy(false); }
  };
  React.useEffect(() => {
    const version = ++generation.current;
    setItems([]); setCursor(null); setError(''); setBusy(enabled);
    if (!enabled) return;
    const timer = setTimeout(() => void fetchPage(query.trim(), undefined, version), 250);
    return () => { clearTimeout(timer); generation.current++; };
  }, [query, enabled, revision]);
  return { items, cursor, busy, error, refresh, loadMore: () => { if (cursor && !busy) void fetchPage(query.trim(), cursor, generation.current); } };
}
