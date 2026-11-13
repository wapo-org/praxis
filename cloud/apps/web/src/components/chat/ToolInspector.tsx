import React from 'react';
import { JsonView, parseLoose } from './JsonView';
import styles from './ToolInspector.module.css';

/**
 * The expanded tool row (K-ref/05): Input and Output each in a soft squircle box with a caption and a copy
 * button, JSON pretty-printed and highlighted, big branches collapsed, escaped text shown as lines.
 * The machine name (`mcp__exa__web_search_exa_<hash>`) is never shown: the owner rejected it even here. Only the connector name is.
 */
export function ToolInspector({
  id,
  connectorName,
  failed,
  warning,
  input,
  progress,
  output,
  copiedId,
  copyText,
}: {
  id: string;
  technical?: string;
  connectorName?: string;
  failed: boolean;
  warning: boolean;
  input: string;
  progress: string;
  output: string;
  copiedId: string | null;
  copyText: (id: string, text: string) => void;
}) {
  return (
    <div className={styles.inspector}>
      {connectorName ? (
        <p className={styles.meta}>
          <span>{connectorName}</span>
        </p>
      ) : null}
      {failed || warning ? (
        <p className={`${styles.reason} ${warning ? styles.warning : styles.failure}`}>
          {warning ? 'Tool call denied' : 'Tool call failed'}
        </p>
      ) : null}
      {input ? <Box caption="Input" text={input} copyId={`${id}:in`} copiedId={copiedId} copyText={copyText} /> : null}
      {progress ? <Box caption="Progress" text={progress} copyId={`${id}:progress`} copiedId={copiedId} copyText={copyText} /> : null}
      {output || !input ? (
        <Box caption="Output" text={output} empty="No output." copyId={id} copiedId={copiedId} copyText={copyText} copyLabel="Copy output" />
      ) : null}
    </div>
  );
}

function Box({
  caption,
  text,
  empty,
  copyId,
  copiedId,
  copyText,
  copyLabel,
}: {
  caption: string;
  text: string;
  empty?: string;
  copyId: string;
  copiedId: string | null;
  copyText: (id: string, text: string) => void;
  copyLabel?: string;
}) {
  const parsed = React.useMemo(() => parseLoose(text), [text]);
  const copied = copiedId === copyId;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const preRef = React.useRef<HTMLPreElement>(null);
  const maxRef = React.useRef<number>(352);
  const [clipped, setClipped] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    setExpanded(false);
  }, [text]);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const mh = getComputedStyle(el).maxHeight;
      if (mh && mh !== 'none') {
        const parsedMax = parseFloat(mh);
        if (Number.isFinite(parsedMax) && parsedMax > 0) maxRef.current = parsedMax;
      }
      setClipped(el.scrollHeight > maxRef.current + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (preRef.current) ro.observe(preRef.current);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <section className={styles.box} data-caption={caption.toLowerCase()}>
      <header className={styles.head}>
        <span className={styles.caption}>{caption}</span>
        <span className={styles.headActions}>
          {clipped ? (
            <button
              type="button"
              className={styles.copy}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          ) : null}
          {text ? (
            <button
              type="button"
              className={styles.copy}
              aria-label={copyLabel ?? `Copy ${caption.toLowerCase()}`}
              onClick={() =>
                copyText(
                  copyId,
                  parsed.kind === 'json' ? JSON.stringify(parsed.value, null, 2) : parsed.text,
                )
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </span>
      </header>
      <div
        ref={scrollRef}
        className={styles.scroll}
        data-clipped={clipped && !expanded}
        data-expanded={expanded}
      >
        <pre ref={preRef} className={styles.pre}>
          {parsed.kind === 'json' ? (
            <JsonView value={parsed.value} />
          ) : (
            parsed.text || <span className={styles.empty}>{empty ?? 'Nothing.'}</span>
          )}
        </pre>
      </div>
    </section>
  );
}
