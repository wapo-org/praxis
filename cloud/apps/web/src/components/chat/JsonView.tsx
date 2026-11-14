import React from 'react';
import styles from './ToolInspector.module.css';

/** Objects and arrays with more entries than this, or this deep, start collapsed. */
export const COLLAPSE_ENTRIES = 8;
export const COLLAPSE_DEPTH = 3;

export type Loose = { kind: 'json'; value: unknown } | { kind: 'text'; text: string };

const looksJson = (s: string) => /^[[{]/.test(s) && /[\]}]$/.test(s);

/** Strings that are themselves JSON (an MCP text block holding a stringified result) become values. */
export function deepParse(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (looksJson(t)) {
      try {
        return deepParse(JSON.parse(t), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => deepParse(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepParse(v, depth + 1)]));
  }
  return value;
}

/** JSON, JSON inside a JSON string, or text whose newlines arrived escaped. */
export function parseLoose(text: string): Loose {
  const t = text.trim();
  if (!t) return { kind: 'text', text: '' };
  if (looksJson(t) || /^"[\s\S]*"$/.test(t)) {
    try {
      const value = JSON.parse(t);
      if (typeof value === 'string') return parseLoose(value);
      return { kind: 'json', value: deepParse(value) };
    } catch {
      /* not JSON after all */
    }
  }
  // Escaped line breaks with no real ones: show them as lines.
  if (!t.includes('\n') && /\\n/.test(t)) {
    return { kind: 'text', text: t.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"') };
  }
  return { kind: 'text', text };
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <span className={styles.json} data-testid="json-view">
      <Node value={value} depth={0} />
    </span>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className={styles.jNull}>null</span>;
  if (typeof value === 'boolean') return <span className={styles.jBool}>{String(value)}</span>;
  if (typeof value === 'number') return <span className={styles.jNum}>{String(value)}</span>;
  if (typeof value === 'string') return <span className={styles.jStr}>{JSON.stringify(value).replace(/\\n/g, '\n').replace(/\\t/g, '\t')}</span>;
  return <span>{String(value)}</span>;
}

function Node({ value, depth, trailing = '' }: { value: unknown; depth: number; trailing?: string }) {
  const isArray = Array.isArray(value);
  const isObject = !!value && typeof value === 'object';
  const entries: Array<[string, unknown]> = isObject
    ? isArray
      ? (value as unknown[]).map((v, i) => [String(i), v])
      : Object.entries(value as Record<string, unknown>)
    : [];
  const big = depth > 0 && (entries.length > COLLAPSE_ENTRIES || depth >= COLLAPSE_DEPTH);
  const [open, setOpen] = React.useState(!big);
  if (!isObject) {
    return (
      <>
        <Scalar value={value} />
        {trailing ? <span className={styles.jPunct}>{trailing}</span> : null}
      </>
    );
  }
  const [o, c] = isArray ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0)
    return (
      <span className={styles.jPunct}>
        {o}
        {c}
        {trailing}
      </span>
    );
  const count = `${entries.length} ${isArray ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}`;
  if (!open)
    return (
      <>
        <button type="button" className={styles.jToggle} aria-expanded={false} data-testid="json-collapsed" onClick={() => setOpen(true)}>
          <span aria-hidden="true">▸</span> {count}
        </button>
        {trailing ? <span className={styles.jPunct}>{trailing}</span> : null}
      </>
    );
  return (
    <>
      {big ? (
        <button type="button" className={styles.jToggle} aria-expanded={true} aria-label={`Collapse ${count}`} onClick={() => setOpen(false)}>
          <span aria-hidden="true">▾</span>
        </button>
      ) : null}
      <span className={styles.jPunct}>{o}</span>
      <span className={styles.jBlock}>
        {entries.map(([k, v], i) => (
          <span key={k} className={styles.jLine}>
            {isArray ? null : (
              <>
                <span className={styles.jKey}>{JSON.stringify(k)}</span>
                <span className={styles.jPunct}>: </span>
              </>
            )}
            <Node value={v} depth={depth + 1} trailing={i < entries.length - 1 ? ',' : ''} />
          </span>
        ))}
      </span>
      <span className={styles.jPunct}>
        {c}
        {trailing}
      </span>
    </>
  );
}
