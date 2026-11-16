import React from 'react';
import { apiClient, PraxisApiError, type SavedValue, type SavedValueQuery } from '../../lib/api';
import { Plus, Search } from '../../lib/icons';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/fields';
import { Modal, modalStyles } from '../ui/Modal';
import { RowGroup, rowClass } from '../ui/RowGroup';
import { ChoiceChip, Field, TaskError, useScreenTask } from './ScreenUI';
import styles from './Screen.module.css';
import saved from './SavedValues.module.css';

/** One page per request; the box loads the next one as its end comes into view. */
export const SAVED_PAGE = 40;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export type SavedFilter = 'all' | 'secret' | 'variable' | 'week' | 'unused';
const FILTERS: Array<{ id: SavedFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'secret', label: 'Secrets' },
  { id: 'variable', label: 'Variables' },
  { id: 'week', label: 'Added this week' },
  { id: 'unused', label: 'Unused' },
];

/** The API query for a filter. "Unused" has no server filter yet: it is applied to each page here. */
export function savedQuery(filter: SavedFilter, query: string, now = Date.now()): SavedValueQuery {
  return {
    query: query.trim() || undefined,
    kind: filter === 'secret' || filter === 'variable' ? filter : undefined,
    since: filter === 'week' ? new Date(now - WEEK_MS).toISOString() : undefined,
    limit: SAVED_PAGE,
  };
}
export const keepRow = (filter: SavedFilter, item: SavedValue) => filter !== 'unused' || !item.lastUsedAt;

/** A variable's one-line preview: strings as they are, anything else as compact JSON. */
export function previewValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.replace(/\s+/g, ' ');
}
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Never');
const unavailable = (error: unknown) =>
  error instanceof PraxisApiError && error.status === 404
    ? 'Saved values are not available on this server yet. Update the server, then retry.'
    : 'Could not load saved values. Try again.';

interface ListState {
  items: SavedValue[];
  cursor: string | null;
  done: boolean;
  loading: boolean;
  error: string;
}
const EMPTY: ListState = { items: [], cursor: null, done: false, loading: true, error: '' };

/** Pages of saved values for a query: a new query starts over and drops any page still in flight. */
function useSavedPages(filter: SavedFilter, query: string) {
  const [state, setState] = React.useState<ListState>(EMPTY);
  const generation = React.useRef(0);
  const inFlight = React.useRef<AbortController | null>(null);
  const cursor = React.useRef<string | null>(null);
  const done = React.useRef(false);

  const load = React.useCallback(
    async (reset: boolean) => {
      if (!reset && (done.current || inFlight.current)) return;
      if (reset) {
        inFlight.current?.abort();
        generation.current++;
        cursor.current = null;
        done.current = false;
      }
      const mine = generation.current;
      const controller = new AbortController();
      inFlight.current = controller;
      setState((s) => (reset ? { ...EMPTY } : { ...s, loading: true, error: '' }));
      try {
        const page = await apiClient.querySavedValues({ ...savedQuery(filter, query), cursor: cursor.current ?? undefined }, controller.signal);
        if (mine !== generation.current) return;
        cursor.current = page.nextCursor;
        done.current = !page.nextCursor;
        setState((s) => {
          const seen = new Set(reset ? [] : s.items.map((item) => item.id));
          const fresh = page.items.filter((item) => keepRow(filter, item) && !seen.has(item.id));
          return { items: [...(reset ? [] : s.items), ...fresh], cursor: page.nextCursor, done: !page.nextCursor, loading: false, error: '' };
        });
      } catch (error) {
        if (controller.signal.aborted || mine !== generation.current) return;
        setState((s) => ({ ...s, loading: false, error: unavailable(error) }));
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
      }
    },
    [filter, query],
  );

  React.useEffect(() => {
    void load(true);
    return () => inFlight.current?.abort();
  }, [load]);
  return { ...state, more: () => void load(false), reload: () => void load(true) };
}

export function SavedValues() {
  const [input, setInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<SavedFilter>('all');
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<SavedValue | null>(null);
  const [notice, setNotice] = React.useState('');
  const list = useSavedPages(filter, query);
  const box = React.useRef<HTMLDivElement>(null);
  const sentinel = React.useRef<HTMLDivElement>(null);

  // Search as you type, a beat after the last key.
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(input), 120);
    return () => clearTimeout(timer);
  }, [input]);

  // The next page when the end of the box comes into view, and again while it stays there (a sparse filter).
  const { more, loading, done, items, error } = list;
  React.useEffect(() => {
    const end = sentinel.current, root = box.current;
    if (!end || !root || done || error || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    }, { root, rootMargin: '0px 0px 240px 0px' });
    observer.observe(end);
    return () => observer.disconnect();
  }, [more, done, error, items.length, loading]);

  const firstLoad = loading && !items.length && !error;
  const ready = !error || items.length > 0;
  const filtered = filter !== 'all' || !!query.trim();
  return (
    <section className={saved.screen} aria-label="Secrets & variables">
      <p className={styles.footnote}>Keep variables for later, or store credentials securely. Secret values are encrypted and write-only.</p>
      <div className={saved.toolbar}>
        <label className={saved.search}>
          <Search size={16} aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search saved values"
            placeholder="Search names and values"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <Button variant="primary" onClick={() => setAdding(true)} disabled={!!error && !items.length}>
          <Plus size={16} aria-hidden="true" />
          Add new
        </Button>
      </div>
      <div className={saved.filters} role="group" aria-label="Filter saved values">
        {FILTERS.map((f) => (
          <ChoiceChip key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </ChoiceChip>
        ))}
      </div>
      {notice ? <p role="status" className={saved.notice}>{notice}</p> : null}
      {error ? (
        <div role="alert" className={saved.loadError}>
          <p>{error}</p>
          <Button onClick={list.reload}>Retry loading</Button>
        </div>
      ) : null}
      {ready ? (
        <RowGroup ref={box} className={saved.box} data-testid="saved-values-box" aria-busy={loading || undefined}>
          {items.map((item) => (
            <div key={item.id} className={`${rowClass()} ${saved.row}`} data-testid={`saved-value-${item.id}`}>
              <span className={saved.name} title={item.name}>{item.name}</span>
              {item.kind === 'secret' ? (
                <span className={saved.masked} aria-label="Value hidden">••••••••</span>
              ) : (
                <span className={saved.preview} title={previewValue(item.value)}>{previewValue(item.value)}</span>
              )}
              <span className={saved.badge} data-kind={item.kind}>{item.kind === 'secret' ? 'Secret' : 'Variable'}</span>
              <Button size="sm" variant="secondary" aria-label={`Edit ${item.name}`} onClick={() => setEditing(item)}>
                Edit
              </Button>
            </div>
          ))}
          {firstLoad || (loading && items.length > 0)
            ? Array.from({ length: firstLoad ? 6 : 2 }, (_, i) => (
                <div key={`skeleton-${i}`} className={`${rowClass()} ${saved.row}`} data-testid="saved-value-skeleton" aria-hidden="true">
                  <span className={saved.skeleton} style={{ '--w': `${30 + ((i * 17) % 25)}%` } as React.CSSProperties} />
                </div>
              ))
            : null}
          {!loading && !items.length && !error ? (
            <div className={`${rowClass()} ${saved.emptyRow}`}>{filtered ? 'No matches.' : 'No saved values yet.'}</div>
          ) : null}
          <div ref={sentinel} className={saved.sentinel} aria-hidden="true" />
        </RowGroup>
      ) : null}
      {adding ? (
        <AddValue
          onClose={() => setAdding(false)}
          onSaved={(kind) => {
            setAdding(false);
            setNotice(kind === 'secret' ? 'Secret saved. Its value stays hidden.' : 'Variable saved.');
            list.reload();
          }}
        />
      ) : null}
      {editing ? (
        <EditValue
          key={editing.id}
          item={editing}
          onClose={() => setEditing(null)}
          onChanged={(message) => {
            setEditing(null);
            setNotice(message);
            list.reload();
          }}
        />
      ) : null}
    </section>
  );
}

function parseVariable(text: string, format: string) {
  if (format !== 'json') return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Enter valid JSON, or choose Text.');
  }
}
const saveError = (error: unknown) =>
  error instanceof Error && error.message.startsWith('Enter valid JSON')
    ? error
    : new Error(error instanceof PraxisApiError && error.status === 413 ? 'Saved values must be smaller than 64 KB.' : 'Could not save this value. Try again.');

function AddValue({ onClose, onSaved }: { onClose: () => void; onSaved: (kind: 'secret' | 'variable') => void }) {
  const [name, setName] = React.useState('');
  const [value, setValue] = React.useState('');
  const [kind, setKind] = React.useState<'variable' | 'secret'>('variable');
  const [format, setFormat] = React.useState('text');
  const [revealed, setRevealed] = React.useState(false);
  const task = useScreenTask();
  const save = () =>
    task.run(async () => {
      try {
        await apiClient.createSavedValue({ name: name.trim(), kind, value: kind === 'variable' ? parseVariable(value, format) : value });
      } catch (error) {
        throw saveError(error);
      }
      onSaved(kind);
    });
  return (
    <Modal title="Add a saved value" onClose={onClose} testId="saved-value-add">
      <form className={saved.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <TaskError error={task.error} />
        <Field label="Name">
          <input aria-label="Saved value name" value={name} maxLength={100} autoFocus disabled={task.busy} onChange={(e) => setName(e.target.value)} placeholder="For example, deployment_region" />
        </Field>
        <div className={saved.pair}>
          <Field label="Type">
            <Select aria-label="Saved value type" value={kind} disabled={task.busy} onChange={(e) => { setKind(e.target.value as 'secret' | 'variable'); setRevealed(false); }}>
              <option value="variable">Variable</option>
              <option value="secret">Secret</option>
            </Select>
          </Field>
          {kind === 'variable' ? (
            <Field label="Format">
              <Select aria-label="Variable format" value={format} disabled={task.busy} onChange={(e) => setFormat(e.target.value)}>
                <option value="text">Text</option>
                <option value="json">JSON</option>
              </Select>
            </Field>
          ) : null}
        </div>
        <Field label="Value">
          {kind === 'secret' ? (
            <input aria-label="Saved secret value" type={revealed ? 'text' : 'password'} autoComplete="off" value={value} disabled={task.busy} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <textarea aria-label="Saved variable value" rows={3} value={value} disabled={task.busy} className={format === 'json' ? styles.mono : undefined} onChange={(e) => setValue(e.target.value)} />
          )}
        </Field>
        <div className={modalStyles.footer}>
          {kind === 'secret' ? (
            <Button variant="quiet" className={modalStyles.footerStart} aria-pressed={revealed} disabled={task.busy} onClick={() => setRevealed((v) => !v)}>
              {revealed ? 'Hide value' : 'Reveal value'}
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={task.busy || !name.trim() || !value}>
            {task.busy ? 'Saving…' : 'Save value'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditValue({ item, onClose, onChanged }: { item: SavedValue; onClose: () => void; onChanged: (message: string) => void }) {
  const secret = item.kind === 'secret';
  const original = secret ? '' : typeof item.value === 'string' ? item.value : JSON.stringify(item.value, null, 2);
  const [name, setName] = React.useState(item.name);
  const [value, setValue] = React.useState(original);
  const [format, setFormat] = React.useState(secret || typeof item.value === 'string' ? 'text' : 'json');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const task = useScreenTask();
  const changed = name.trim() !== item.name || (secret ? value.length > 0 : value !== original || format !== (typeof item.value === 'string' ? 'text' : 'json'));
  const save = () =>
    task.run(async () => {
      const patch: { name?: string; value?: unknown } = {};
      if (name.trim() !== item.name) patch.name = name.trim();
      if (secret ? value.length > 0 : value !== original || format !== (typeof item.value === 'string' ? 'text' : 'json'))
        patch.value = secret ? value : parseVariable(value, format);
      try {
        await apiClient.updateSavedValue(item.id, patch);
      } catch (error) {
        throw saveError(error);
      }
      onChanged(secret && patch.value !== undefined ? 'Secret replaced. Its value stays hidden.' : 'Saved.');
    });
  const remove = () =>
    task.run(async () => {
      try {
        await apiClient.deleteSavedValue(item.id);
      } catch {
        throw new Error('Could not delete this value. Try again.');
      }
      onChanged(`${item.name} deleted.`);
    });
  return (
    <Modal title={secret ? 'Edit secret' : 'Edit variable'} onClose={onClose} testId="saved-value-edit">
      <form className={saved.form} onSubmit={(e) => { e.preventDefault(); if (changed) void save(); }}>
        <TaskError error={task.error} />
        <Field label="Name">
          <input aria-label={'Name for ' + item.name} value={name} maxLength={100} disabled={task.busy} onChange={(e) => setName(e.target.value)} />
        </Field>
        {secret ? (
          <Field label="Replace value" hint="The current value stays hidden. Leave this empty to keep it.">
            <input aria-label="Replace secret value" type="password" autoComplete="new-password" value={value} disabled={task.busy} onChange={(e) => setValue(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label="Format">
              <Select aria-label="Variable format" value={format} disabled={task.busy} onChange={(e) => setFormat(e.target.value)}>
                <option value="text">Text</option>
                <option value="json">JSON</option>
              </Select>
            </Field>
            <Field label="Value">
              <textarea aria-label="Variable value" rows={4} value={value} disabled={task.busy} className={styles.mono} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </>
        )}
        <dl className={saved.meta}>
          <div><dt>Added</dt><dd>{date(item.createdAt)}</dd></div>
          <div><dt>Last used</dt><dd>{date(item.lastUsedAt)}</dd></div>
        </dl>
        {confirmDelete ? (
          <div className={saved.confirm} role="alert">
            <p>Delete {item.name}? Chats that use it will no longer find it.</p>
            <div className={modalStyles.footer}>
              <Button onClick={() => setConfirmDelete(false)} disabled={task.busy}>Keep</Button>
              <Button variant="destructive" onClick={() => void remove()} disabled={task.busy}>
                {task.busy ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        ) : (
          <div className={modalStyles.footer}>
            <Button variant="destructive" className={modalStyles.footerStart} onClick={() => setConfirmDelete(true)} disabled={task.busy}>
              Delete
            </Button>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={task.busy || !changed || !name.trim()}>
              {task.busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Compatibility for saved-secret previews and existing imports. */
export const SavedSecrets = SavedValues;
