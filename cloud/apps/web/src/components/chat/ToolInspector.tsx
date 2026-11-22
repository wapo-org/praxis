import React from 'react';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockTitle,
} from '../ui/code-block';
import { JsonView, parseLoose } from './JsonView';
import styles from './ToolInspector.module.css';

type FadeEdge = 'none' | 'top' | 'bottom' | 'both';

export function ToolInspector({
  id,
  connectorName,
  failed,
  warning,
  input,
  progress,
  output,
  copiedId: _copiedId,
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
  const errorLabel = warning ? 'Tool call denied' : 'Tool call failed';
  const errorText = output
    ? output.toLowerCase().includes('tool call failed') || output.toLowerCase().includes('tool call denied')
      ? output
      : `${errorLabel}: ${output}`
    : errorLabel;

  return (
    <div className={styles.inspector}>
      {connectorName ? (
        <p className={styles.meta}>
          <span>{connectorName}</span>
        </p>
      ) : null}
      {input ? (
        <Box
          caption="Input"
          text={input}
          copyId={`${id}:in`}
          copyText={copyText}
        />
      ) : null}
      {progress ? (
        <Box
          caption="Progress"
          text={progress}
          copyId={`${id}:progress`}
          copyText={copyText}
        />
      ) : null}
      {failed || warning ? (
        <Box
          caption="Error"
          title={errorLabel}
          variant="destructive"
          text={errorText}
          copyId={id}
          copyText={copyText}
          copyLabel="Copy error"
        />
      ) : output || !input ? (
        <Box
          caption="Output"
          text={output}
          empty="No output."
          copyId={id}
          copyText={copyText}
          copyLabel="Copy output"
          scrollable
        />
      ) : null}
    </div>
  );
}

function Box({
  caption,
  title,
  variant = 'default',
  text,
  empty,
  copyId,
  copyText,
  copyLabel,
  scrollable = false,
}: {
  caption: string;
  title?: string;
  variant?: 'default' | 'destructive';
  text: string;
  empty?: string;
  copyId: string;
  copyText: (id: string, text: string) => void;
  copyLabel?: string;
  scrollable?: boolean;
}) {
  const parsed = React.useMemo(() => parseLoose(text), [text]);
  const contentRef = React.useRef<HTMLPreElement>(null);
  const maxRef = React.useRef<number>(272);
  const [overflows, setOverflows] = React.useState(false);
  const [fade, setFade] = React.useState<FadeEdge>('none');
  const [expanded, setExpanded] = React.useState(false);

  const copyPayload =
    parsed.kind === 'json' ? JSON.stringify(parsed.value, null, 2) : parsed.text;

  React.useEffect(() => {
    setExpanded(false);
  }, [text]);

  const measure = React.useCallback(() => {
    if (!scrollable) {
      setOverflows(false);
      setFade('none');
      return;
    }
    const el = contentRef.current;
    if (!el) return;
    const mh = getComputedStyle(el).maxHeight;
    if (mh && mh !== 'none') {
      const parsedMax = Number.parseFloat(mh);
      if (Number.isFinite(parsedMax) && parsedMax > 0) {
        maxRef.current = parsedMax;
      }
    }
    const hasOverflow = el.scrollHeight > maxRef.current + 1;
    setOverflows(hasOverflow);
    if (expanded || el.scrollHeight <= el.clientHeight + 1) {
      setFade('none');
      return;
    }
    const moreAbove = el.scrollTop > 1;
    const moreBelow = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    if (moreAbove && moreBelow) setFade('both');
    else if (moreAbove) setFade('top');
    else if (moreBelow) setFade('bottom');
    else setFade('none');
  }, [scrollable, expanded]);

  React.useLayoutEffect(() => {
    measure();
    if (!scrollable || typeof ResizeObserver === 'undefined') return;
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure, scrollable, text]);

  return (
    <section className={styles.section} data-caption={caption.toLowerCase()}>
      <CodeBlock size="sm" variant={variant}>
        <CodeBlockHeader>
          <CodeBlockTitle>{title ?? caption}</CodeBlockTitle>
          <CodeBlockActions>
            {text ? (
              <CodeBlockCopyButton
                value={copyPayload}
                aria-label={copyLabel ?? `Copy ${caption.toLowerCase()}`}
                onClick={() => copyText(copyId, copyPayload)}
              />
            ) : null}
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent
          ref={contentRef}
          wrap
          className={scrollable ? styles.scrollContent : undefined}
          data-expanded={scrollable ? (expanded ? 'true' : 'false') : undefined}
          data-fade={scrollable ? fade : undefined}
          onScroll={scrollable ? measure : undefined}
        >
          {parsed.kind === 'json' ? (
            <JsonView value={parsed.value} />
          ) : (
            parsed.text || <span className={styles.empty}>{empty ?? 'Nothing.'}</span>
          )}
        </CodeBlockContent>
        {scrollable && (overflows || expanded) ? (
          <CodeBlockFooter>
            <button
              type="button"
              className={styles.showAll}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          </CodeBlockFooter>
        ) : null}
      </CodeBlock>
    </section>
  );
}
