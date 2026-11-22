import { getUnpinnedModels, modelDetail } from '../../lib/models';
import type { ModelListItem } from '@praxis/protocol';
import { ScrollBlur } from '@praxis/glass';

import React from 'react';
import { Check, ChevronLeft, Search, Star, X } from '../../lib/icons';
import { useModelSearch } from '../../lib/useModelSearch';
import { usePraxisStore } from '../../state/store';
import { actionOptions, applyOption } from '../../actions/registry';
import styles from './ModelList.module.css';

type Model = ModelListItem;

/** Rows are fixed-height so the window is plain arithmetic; these mirror the CSS tokens. */
export const MODEL_ROW_HEIGHT = 56; // --row-model
const LABEL_ROW_HEIGHT = 32; // --space-8
const MORE_ROW_HEIGHT = 44; // --control-lg
const OVERSCAN = 6;

export type ModelListRow =
  | { kind: 'label'; key: string; text: string; height: number; top: number }
  | { kind: 'model'; key: string; model: Model; height: number; top: number }
  | { kind: 'more'; key: string; height: number; top: number };

/** Pinned first, then the recommended models, then the rest of the catalogue. A section with no models has no header. */
export function buildModelRows(items: Model[], searching: boolean, hasMore: boolean): ModelListRow[] {
  const rows: ModelListRow[] = [];
  let top = 0;
  const push = (row: Omit<ModelListRow, 'top'>) => {
    rows.push({ ...row, top } as ModelListRow);
    top += row.height;
  };
  const addModels = (models: Model[]) => {
    for (const model of models)
      push({ kind: 'model', key: model.id, model, height: MODEL_ROW_HEIGHT } as Omit<ModelListRow, 'top'>);
  };
  if (searching) addModels(items);
  else {
    const pinned = items.filter((m) => m.pinned || m.favorite);
    const unpinned = getUnpinnedModels(items);
    const recommended = unpinned.filter((m) => m.recommended);
    const others = unpinned.filter((m) => !m.recommended);
    if (pinned.length) {
      push({ kind: 'label', key: 'label-pinned', text: 'Pinned', height: LABEL_ROW_HEIGHT } as Omit<ModelListRow, 'top'>);
      addModels(pinned);
    }
    if (recommended.length) {
      push({ kind: 'label', key: 'label-recommended', text: 'Recommended', height: LABEL_ROW_HEIGHT } as Omit<ModelListRow, 'top'>);
      addModels(recommended);
    }
    if (others.length) {
      const text = `All models · ${others.length}${hasMore ? '+' : ''}`;
      push({ kind: 'label', key: 'label-all', text, height: LABEL_ROW_HEIGHT } as Omit<ModelListRow, 'top'>);
      addModels(others);
    }
  }
  if (hasMore) push({ kind: 'more', key: 'more', height: MORE_ROW_HEIGHT });
  return rows;
}

/** Index of the first row whose bottom edge is below `offset`. */
function firstRowAt(rows: ModelListRow[], offset: number) {
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid]!.top + rows[mid]!.height <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

const ModelRow = React.memo(function ModelRow({
  model,
  optionId,
  selected,
  active,
  onSelect,
  onTogglePin,
}: {
  model: Model;
  optionId: string;
  selected: boolean;
  active: boolean;
  onSelect: (model: Model) => void;
  onTogglePin: (model: Model) => void;
}) {
  return (
    <div className={styles.row} role="none">
      <button
        type="button"
        id={optionId}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        data-active={active}
        data-testid={`model-option-${model.id}`}
        className={styles.option}
        onClick={() => onSelect(model)}
      >
        <span className={styles.copy}>
          <span className={styles.name}>{model.name}</span><span className={styles.meta}>{modelDetail(model)}</span>

        </span>
        {selected ? (
          <span className={styles.check}>
            <Check size={16} />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={styles.pin}
        aria-pressed={model.pinned}
        aria-label={`${model.pinned ? 'Unpin' : 'Pin'} ${model.name}`}
        onClick={() => onTogglePin(model)}
      >
        <Star size={16} />
      </button>
    </div>
  );
});

/** The tray's second page: search plus a windowed list, smooth with thousands of models. */
export function ModelList({ onBack, autoFocus = true }: { onBack: () => void; autoFocus?: boolean }) {
  const store = usePraxisStore();
  const [query, setQuery] = React.useState('');
  const search = useModelSearch(query, true, store.models);
  const searching = !!query.trim();
  const rows = React.useMemo(
    () => buildModelRows(actionOptions('model', store, search.items).flatMap(o => o.model ? [o.model] : []), searching, !!search.cursor),
    [search.items, searching, search.cursor],
  );
  const total = rows.length ? rows.at(-1)!.top + rows.at(-1)!.height : 0;

  const viewport = React.useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = React.useState(0);
  const [firstVisible, setFirstVisible] = React.useState(0);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const listId = React.useId();
  const input = React.useRef<HTMLInputElement>(null);

  React.useLayoutEffect(() => {
    const measure = () => setViewportHeight(viewport.current?.clientHeight ?? 0);
    measure();
    if (autoFocus) input.current?.focus({ preventScroll: true });
    if (typeof ResizeObserver === 'undefined' || !viewport.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [autoFocus]);

  React.useEffect(() => {
    setActiveIndex(-1);
    setFirstVisible(0);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [query]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const next = rows.length ? firstRowAt(rows, el.scrollTop) : 0;
    if (next !== firstVisible) setFirstVisible(next);
    if (el.scrollTop + el.clientHeight > total - MODEL_ROW_HEIGHT * 4) search.loadMore();
  };

  const select = React.useCallback(
    (model: Model) => {
      applyOption('model', store, model.id, [model]);
      onBack();
    },
    [store.cacheModels, store.setSelectedModel, onBack],
  );
  const { patch, refresh } = search;
  const togglePin = React.useCallback(
    (model: Model) => {
      patch({ id: model.id, pinned: !model.pinned });
      void store.toggleModelPin(model.id, !model.pinned).catch(refresh);
    },
    [store.toggleModelPin, patch, refresh],
  );

  const activate = (row: ModelListRow | undefined) => {
    if (row?.kind === 'model') select(row.model);
    else if (row?.kind === 'more') search.loadMore();
  };
  const moveActive = (from: number, step: 1 | -1) => {
    for (let next = from + step; next >= 0 && next < rows.length; next += step) {
      const row = rows[next]!;
      if (row.kind === 'label') continue;
      setActiveIndex(next);
      const el = viewport.current;
      if (el) {
        if (row.top < el.scrollTop) el.scrollTop = row.top;
        else if (row.top + row.height > el.scrollTop + el.clientHeight)
          el.scrollTop = row.top + row.height - el.clientHeight;
      }
      return;
    }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const page = Math.max(1, Math.floor((viewport.current?.clientHeight ?? 0) / MODEL_ROW_HEIGHT));
    if (event.key === 'ArrowDown') moveActive(activeIndex, 1);
    else if (event.key === 'ArrowUp') moveActive(activeIndex === -1 ? rows.length : activeIndex, -1);
    else if (event.key === 'Home') moveActive(-1, 1);
    else if (event.key === 'End') moveActive(rows.length, -1);
    else if (event.key === 'PageDown') moveActive(Math.min(rows.length - 2, activeIndex + page - 1), 1);
    else if (event.key === 'PageUp') moveActive(Math.max(1, activeIndex - page + 1), -1);
    else if (event.key === 'Enter') {
      activate(rows[activeIndex] ?? rows.find((row) => row.kind === 'model'));
    } else return;
    event.preventDefault();
  };

  const visibleCount = Math.ceil(viewportHeight / LABEL_ROW_HEIGHT) + OVERSCAN;
  const start = Math.max(0, firstVisible - OVERSCAN);
  const windowed = rows.slice(start, start + visibleCount + OVERSCAN);
  const showEmpty = !search.busy && !search.error && rows.length === 0;
  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <button type="button" className={styles.back} aria-label="Back" onClick={onBack}>
          <ChevronLeft size={20} />
        </button>
        <label className={styles.search}>
          <Search size={16} />
          <input
            ref={input}
            className={styles.searchInput}
            type="text"
            role="combobox"
            aria-label="Search models"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {query ? (
            <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={16} />
            </button>
          ) : null}
        </label>
      </div>
      {search.error ? (
        <p role="alert" className={`${styles.note} ${styles.error}`}>
          {search.error}
        </p>
      ) : null}
      {showEmpty ? <p className={styles.note}>No models found.</p> : null}
      {search.busy && rows.length === 0 ? <p className={styles.note} role="status">Loading models…</p> : null}
      <ScrollBlur
        className={styles.list}
        height="100%"
        viewportRef={viewport}
        onViewportScroll={handleScroll}
      >
        <div
          id={listId}
          role="listbox"
          aria-label="Models"
          aria-busy={search.busy}
          className={styles.spacer}
          style={{ height: total }}
        >
          {windowed.map((row, offset) => {
            const index = start + offset;
            return (
              <div
                key={row.key}
                className={styles.slot}
                role="none"
                style={{ height: row.height, transform: `translateY(${row.top}px)` }}
              >
                {row.kind === 'label' ? (
                  <div className={styles.label} role="presentation">
                    {row.text}
                  </div>
                ) : row.kind === 'more' ? (
                  <button
                    type="button"
                    id={optionId(index)}
                    role="option"
                    tabIndex={-1}
                    aria-selected="false"
                    data-active={index === activeIndex}
                    className={styles.more}
                    disabled={search.busy}
                    onClick={search.loadMore}
                  >
                    Load more models
                  </button>
                ) : (
                  <ModelRow
                    model={row.model}
                    optionId={optionId(index)}
                    selected={row.model.id === store.selectedModelId}
                    active={index === activeIndex}
                    onSelect={select}
                    onTogglePin={togglePin}
                  />
                )}
              </div>
            );
          })}
        </div>
      </ScrollBlur>
    </div>
  );
}
