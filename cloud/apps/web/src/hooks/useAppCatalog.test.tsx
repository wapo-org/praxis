// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppCatalog, useAppCatalog } from './useAppCatalog';

const catalogAction = vi.fn();
vi.mock('convex/react', () => ({ useAction: () => catalogAction }));

let container: HTMLDivElement;
let root: Root;
let latest: AppCatalog;

function Harness({ query }: { query: string }) {
  latest = useAppCatalog(query);
  return null;
}

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
beforeEach(() => {
  vi.useFakeTimers();
  catalogAction.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function renderQuery(query: string) {
  await act(async () => {
    root.render(<Harness query={query} />);
  });
}

describe('useAppCatalog', () => {
  it('fetches the first page on mount and appends unique items on loadMore', async () => {
    catalogAction
      .mockResolvedValueOnce({
        items: [{ toolkit: 'gmail', name: 'Gmail', description: 'Email' }],
        nextCursor: 'page-2',
        totalItems: 2,
      })
      .mockResolvedValueOnce({
        items: [
          { toolkit: 'gmail', name: 'Gmail', description: 'Email' },
          { toolkit: 'trello', name: 'Trello', description: 'Boards' },
        ],
        nextCursor: null,
        totalItems: 2,
      });

    await renderQuery('');
    expect(latest.state).toBe('ready');
    expect(latest.items.map((app) => app.toolkit)).toEqual(['gmail']);
    expect(latest.hasMore).toBe(true);
    expect(catalogAction).toHaveBeenCalledWith({});

    await act(async () => {
      latest.loadMore();
    });
    expect(latest.items.map((app) => app.toolkit)).toEqual(['gmail', 'trello']);
    expect(latest.hasMore).toBe(false);
    expect(catalogAction).toHaveBeenLastCalledWith({ cursor: 'page-2' });
  });

  it('debounces search queries and surfaces an error with retry', async () => {
    catalogAction
      .mockResolvedValueOnce({ items: [], nextCursor: null, totalItems: 0 })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        items: [{ toolkit: 'notion', name: 'Notion', description: 'Docs' }],
        nextCursor: null,
        totalItems: 1,
      });

    await renderQuery('');
    await renderQuery('not');
    expect(catalogAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(catalogAction).toHaveBeenLastCalledWith({ search: 'not' });
    expect(latest.state).toBe('error');

    await act(async () => {
      latest.retry();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(latest.state).toBe('ready');
    expect(latest.items.map((app) => app.toolkit)).toEqual(['notion']);
  });

  it('fails closed when the catalog response is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    catalogAction.mockResolvedValueOnce({ items: [{ toolkit: '' }], nextCursor: null, totalItems: 1 });
    await renderQuery('');
    expect(latest.state).toBe('error');
    expect(latest.items).toEqual([]);
    warn.mockRestore();
  });
});
