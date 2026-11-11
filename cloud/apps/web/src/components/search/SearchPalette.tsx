import { GlassSurface, LEAVE_CONTENT, SPRING, TRANSITION, useReducedMotion, usePreset, searchArrival } from '@praxis/glass';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
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
/** Words too common to emphasise: natural-language (semantic) queries would bold every "a" and "for". */
const QUIET = new Set('a an and are as at be by can do does for from how i in is it me my of on or so that the this to was what when where which who why will with you your'.split(' '));
/** Emphasises the query's meaningful words where a word starts with them ("pack" in "Packing"). */
export function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/u).filter(w => w && !QUIET.has(w.toLocaleLowerCase()))
    .sort((a, b) => b.length - a.length).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${words.join('|')})`, 'giu');
  return <>{text.split(pattern).map((part, i) => i % 2 ? <strong key={i}>{part}</strong> : part)}</>;
}
/**
 * Owns whether search is open, so opening and closing it re-renders only the palette. While this state lived
 * in App, every close re-rendered the sidebar and the whole chat inside the key or click handler (~37 ms in
 * Chromium on a 120 Hz Mac, a dropped frame at the start of the close; WP-J2).
 */
export function SearchHost() {
  const { setPlusTrayOpen, setDesktopSidebarOpen } = usePraxisStore();
  const [open, setOpen] = React.useState(false);
  const actions = React.useRef({ setPlusTrayOpen, setDesktopSidebarOpen });
  actions.current = { setPlusTrayOpen, setDesktopSidebarOpen };
  React.useEffect(() => {
    const show = () => {
      actions.current.setPlusTrayOpen(false);
      if (window.matchMedia('(max-width: 1023px)').matches) actions.current.setDesktopSidebarOpen(false);
      setOpen(true);
    };
    const toggle = () => (openRef.current ? closeRef.current() : show());
    window.addEventListener('praxis:search', show);
    window.addEventListener('praxis:search-toggle', toggle);
    return () => {
      window.removeEventListener('praxis:search', show);
      window.removeEventListener('praxis:search-toggle', toggle);
    };
  }, []);
  // Work that would cost a frame (switching chats renders and commits the whole chat in one task) waits
  // until the close has finished and the palette's last frame is painted.
  const after = React.useRef<(() => void) | null>(null);
  const close = React.useCallback((then?: () => void) => { after.current = then ?? null; setOpen(false); }, []);
  const openRef = React.useRef(open);
  openRef.current = open;
  const closeRef = React.useRef(() => close());
  closeRef.current = () => close();
  const exited = React.useCallback(() => { const run = after.current; after.current = null; if (run) requestAnimationFrame(() => setTimeout(run, 0)); }, []);
  return <SearchPalette open={open} onClose={close} onExitComplete={exited} />;
}
export function SearchPalette({ open, onClose, onExitComplete }: { open: boolean; onClose: (then?: () => void) => void; onExitComplete?: () => void }) {
  return createPortal(<AnimatePresence onExitComplete={onExitComplete}>{open ? <Palette key="search" onClose={onClose} /> : null}</AnimatePresence>, document.body);
}
function Palette({ onClose }: { onClose: (then?: () => void) => void }) {
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
  // Closing starts now, not when the exit ends: no focus, no hit-testing and no listeners while it fades.
  const present = useIsPresent();
  const previous = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus({ preventScroll: true });
  }, []);
  React.useEffect(() => {
    if (!present) {
      if (surface.current?.contains(document.activeElement) && previous.current?.isConnected) previous.current.focus({ preventScroll: true });
      return;
    }
    const outside = (e: PointerEvent) => { if (!surface.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [present, onClose]);
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
    if (!present) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      level ? back() : onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [level, onClose, present]);
  // An action closes the palette at once, like a chat row; it runs once the close has finished, and a failure
  // goes to the app's error banner instead of holding the palette open (New chat creates a chat first).
  const run = (fn: () => unknown) => onClose(() => {
    void Promise.resolve().then(fn).catch(() => store.reportError('Couldn’t apply that action. Try again.'));
  });
  const options = level ? actionOptions(level, store, level === 'model' ? modelSearch.items : store.models)
    .filter(o => level === 'model' || o.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : [];
  const commands = level ? [] : (Object.keys(ACTIONS) as ActionId[]).filter(key =>
    ACTIONS[key].available(store) && ACTIONS[key].label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const rows: SearchRow[] = level ? options.map(option => ({ id: option.id, label: option.label, snippet: '', Icon: ACTIONS[level].Icon,
    selected: option.selected, apply: () => run(() => applyOption(level, store, option.id, modelSearch.items)) })) : [
    ...commands.map(key => ({ id: key, label: ACTIONS[key].label, snippet: '', Icon: ACTIONS[key].Icon, selected: false,
      apply: () => { if ('options' in ACTIONS[key]) { setLevel(key); setQuery(''); setHits([]); } else void run(() => applyOption(key, store, '')); } })),
    ...(query.trim() ? hits : []).map(hit => ({ id: `chat-${hit.chat.id}`, label: hit.chat.title || 'New chat', snippet: hit.snippet,
      // Close now, like any dismiss; the switch runs the moment the close has finished (selectChat reports its
      // own errors). Awaiting it held the palette open for the whole message fetch; running it during the
      // close dropped frames in Chromium.
      Icon: MessageCircle, selected: false, apply: () => onClose(() => { store.setActiveSheet(null); void store.selectChat(hit.chat.id); }) })),
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
              {row.snippet ? <small><Highlight text={row.snippet} query={query} /></small> : null}</span>{row.selected ? <Check size={16} /> : null}
          </button>)}
          {message ? <p className={styles.note} role="status">{message}</p> : null}
        </div>
      </div>
    </motion.div>
  </>;
  return <div ref={surface} className={styles.position} data-testid="search-palette" data-state={present ? 'open' : 'closing'}
    inert={!present} style={present ? undefined : { pointerEvents: 'none' }}>
    <GlassSurface material="thick" className={styles.surface}
      {...arrival}>
      {/* The dropdowns' one crisp line (morph.module.css .rim): the same subtle border in both themes. */}
      <span aria-hidden="true" data-search-rim="" className={styles.rim} />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: LEAVE_CONTENT }} transition={TRANSITION.fast}>{contents}</motion.div>
      {!reduced ? <motion.div aria-hidden="true" className={`${styles.bar} ${styles.blur}`} initial={{ opacity: 1 }} animate={{ opacity: 0 }} exit={{ opacity: 0, transition: LEAVE_CONTENT }} transition={TRANSITION.fast}>
        <Search size={20} /><span>{query || (level ? ACTIONS[level].label : 'Search chats and actions')}</span>
      </motion.div> : null}
    </GlassSurface>
  </div>;
}
