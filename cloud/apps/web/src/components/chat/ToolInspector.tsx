import React from 'react';
import { JsonView, parseLoose } from './JsonView';
import styles from './ToolInspector.module.css';

/**
 * The expanded tool row (K-ref/05): Input and Output each in a soft squircle box with a caption and a copy
 * button, JSON pretty-printed and highlighted, big branches collapsed, escaped text shown as lines.
 * The machine name lives here and nowhere else.
 */
export function ToolInspector({
  id,
  technical,
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
      {technical ? (
        <p className={styles.meta}>
          {connectorName ? <span>{connectorName}</span> : null}
          <code className={styles.technical} title={technical}>
            {technical}
          </code>
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
  return (
    <section className={styles.box} data-caption={caption.toLowerCase()}>
      <header className={styles.head}>
        <span className={styles.caption}>{caption}</span>
        {text ? (
          <button type="button" className={styles.copy} aria-label={copyLabel ?? `Copy ${caption.toLowerCase()}`} onClick={() => copyText(copyId, parsed.kind === 'json' ? JSON.stringify(parsed.value, null, 2) : parsed.text)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
      </header>
      <div className={styles.scroll}>
        <pre className={styles.pre}>
          {parsed.kind === 'json' ? <JsonView value={parsed.value} /> : parsed.text || <span className={styles.empty}>{empty ?? 'Nothing.'}</span>}
        </pre>
      </div>
    </section>
  );
}
