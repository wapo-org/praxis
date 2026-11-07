import { GlassSurface, SPRING, TRANSITION, useReducedMotion, usePreset, searchArrival } from '@praxis/glass';
import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { createPortal } from 'react-dom';
import { ACTIONS, actionOptions, applyOption, type ActionId } from '../../actions/registry';
import { apiClient } from '../../lib/api';
import { Check, ChevronLeft, MessageCircle, Search } from '../../lib/icons';
import { useModelSearch } from '../../lib/useModelSearch';
import { usePraxisStore } from '../../state/store';
import modelStyles from '../chat/ModelList.module.css';
import styles from './SearchPalette.module.css';

type SearchRow = { id: string; label: string; snippet: string; Icon: typeof Search; selected: boolean; apply: () => void | Promise<void> };
type Hit = Awaited<ReturnType<typeof apiClient.searchChats>>['items'][number];
export function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/u).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.join('|')})`, 'giu');
  return <>{text.split(pattern).map((part, i) => i % 2 ? <strong key={i}>{part}</strong> : part)}</>;
}
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  return createPortal(<AnimatePresence>{open ? <Palette key="search" onClose={onClose} /> : null}</AnimatePresence>, document.body);
}
function Palette({ onClose }: { onClose: () => void }) {
  const store = usePraxisStore();
  const reduced = useReducedMotion();
  const arrival = usePreset(searchArrival);
  const [query, setQuery] = React.useState('');
  const [level, setLevel] = React.useState<ActionId | null>(null);
  const [hits, setHits] = React.useState<Hit[]>([]);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const input = React.useRef<HTMLInputElement>(null);
  const surface = React.useRef<HTMLDivElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const modelSearch = useModelSearch(level === 'model' ? query : '', level === 'model', store.models);
  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => { if (!surface.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('pointerdown', outside); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  React.useEffect(() => {
    let stale = false;
    setError('');
    if (level || !query.trim()) { setHits([]); setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(() => {
      void apiClient.searchChats(query.trim()).then(page => { if (!stale) setHits(page.items); })
        .catch(() => { if (!stale) { setHits([]); setError('Search unavailable. Try again.'); } })
        .finally(() => { if (!stale) setBusy(false); });
    }, 200);
    return () => { stale = true; clearTimeout(timer); };
  }, [query, level]);
  React.useEffect(() => { setActive(0); if (list.current) list.current.scrollTop = 0; }, [query, level]);
  const back = () => { setLevel(null); setQuery(''); input.current?.focus(); };
  React.useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      level ? back() : onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [level, onClose]);
  const run = async (fn: () => unknown) => {
    try { await fn(); onClose(); } catch { setError('Unable to apply action. Try again.'); }
  };
  const options = level ? actionOptions(level, store, level === 'model' ? modelSearch.items : store.models)
    .filter(o => level === 'model' || o.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : [];
  const commands = level ? [] : (Object.keys(ACTIONS) as ActionId[]).filter(key =>
    ACTIONS[key].available(store) && ACTIONS[key].label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const rows: SearchRow[] = level ? options.map(option => ({ id: option.id, label: option.label, snippet: '', Icon: ACTIONS[level].Icon,
    selected: option.selected, apply: () => run(() => applyOption(level, store, option.id, modelSearch.items)) })) : [
    ...commands.map(key => ({ id: key, label: ACTIONS[key].label, snippet: '', Icon: ACTIONS[key].Icon, selected: false,
      apply: () => { if ('options' in ACTIONS[key]) { setLevel(key); setQuery(''); setHits([]); } else void run(() => applyOption(key, store, '')); } })),
    ...(query.trim() ? hits : []).map(hit => ({ id: `chat-${hit.chat.id}`, label: hit.chat.title || 'New chat', snippet: hit.snippet,
      Icon: MessageCircle, selected: false, apply: () => run(() => { store.setActiveSheet(null); return store.selectChat(hit.chat.id); }) })),
  ];
  if (level === 'model' && modelSearch.cursor) rows.push({ id: 'load-more', label: 'Load more models', snippet: '',
    Icon: Search, selected: false, apply: modelSearch.loadMore });
  // Start as the bar only. The first query reveals rows; subsequent swaps never animate rows.
  const showRows = !!query.trim() || !!level;
  const visibleRows = showRows ? rows : [];
  const activeIndex = Math.min(active, Math.max(0, visibleRows.length - 1));
  const message = error || (level === 'model' ? modelSearch.error : '') || (showRows && !visibleRows.length && !(busy || modelSearch.busy) ? 'No results.' : '');
  const body = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(0);
  React.useLayoutEffect(() => {
    const measure = () => setHeight(body.current?.offsetHeight ?? 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (body.current) observer.observe(body.current);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => { document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' }); }, [activeIndex, id]);
  const contents = <>
    <div className={styles.bar}>
      {level ? <button className={styles.back} aria-label="Back to search" onClick={back}><ChevronLeft size={18} /></button> : <Search size={20} />}
      <input ref={input} role="combobox" aria-label="Search conversations" aria-controls={id} aria-expanded={showRows}
        aria-autocomplete="list" aria-activedescendant={visibleRows[activeIndex] ? `${id}-${activeIndex}` : undefined}
        placeholder={level ? ACTIONS[level].label : 'Search chats and actions'} value={query}
        onChange={e => setQuery(e.target.value)} onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape' || (e.key === 'Backspace' && !query && level)) { e.preventDefault(); e.stopPropagation(); level ? back() : onClose(); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, Math.min(visibleRows.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1)))); }
          else if (e.key === 'Enter') { e.preventDefault(); void visibleRows[activeIndex]?.apply(); }
        }} />
    </div>
    <motion.div className={styles.reveal} initial={false} animate={{ height }} transition={reduced ? TRANSITION.none : SPRING}>
      <div ref={body}>
        <div ref={list} id={id} role="listbox" aria-label={level ? ACTIONS[level].label : 'Search results'} className={styles.results}>
          {visibleRows.map((row, index) => <button key={row.id} id={`${id}-${index}`} type="button" role="option"
            aria-selected={row.selected} data-active={activeIndex === index} className={`${modelStyles.option} ${styles.row}`} tabIndex={-1}
            onPointerMove={() => setActive(index)} onClick={() => void row.apply()}>
            <row.Icon size={18} /><span className={styles.copy}><span><Highlight text={row.label} query={query} /></span>
              {row.snippet ? <small><Highlight text={row.snippet} query={query} /></small> : null}</span>{row.selected ? <Check size={18} /> : null}
          </button>)}
          {message ? <p className={styles.note} role="status">{message}</p> : null}
        </div>
      </div>
    </motion.div>
  </>;
  return <div ref={surface} className={styles.position} data-testid="search-palette">
    <GlassSurface material="thick" radius={20} className={styles.surface}
      {...arrival}>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={TRANSITION.fast}>{contents}</motion.div>
      {!reduced ? <motion.div aria-hidden="true" className={`${styles.bar} ${styles.blur}`} initial={{ opacity: 1 }} animate={{ opacity: 0 }} exit={{ opacity: 1 }} transition={TRANSITION.fast}>
        <Search size={20} /><span>{query || (level ? ACTIONS[level].label : 'Search chats and actions')}</span>
      </motion.div> : null}
    </GlassSurface>
  </div>;
}
