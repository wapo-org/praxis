import React from 'react';
import { WrapText } from 'lucide-react';
import { Check, ChevronDown, Copy } from '../../../lib/icons';
import styles from './CodeBlock.module.css';

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

export type CodeBlockVariant = 'default' | 'destructive';
export type CodeBlockSize = 'default' | 'sm';

export function CodeBlock({ className, variant = 'default', size = 'default', ...props }: React.ComponentProps<'div'> & { variant?: CodeBlockVariant; size?: CodeBlockSize }) {
  return <div data-slot="code-block" data-variant={variant} data-size={size} className={cx(styles.root, className)} {...props} />;
}

export function CodeBlockHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="code-block-header" className={cx(styles.header, className)} {...props} />;
}

export function CodeBlockTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="code-block-title" className={cx(styles.title, className)} {...props} />;
}

/** In a header, the actions sit at its end; as a direct child of the block they float over the code. */
export function CodeBlockActions({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="code-block-actions" className={cx(styles.actions, className)} {...props} />;
}

export function CodeBlockCopyButton({ value, className, onClick, ...props }: Omit<React.ComponentProps<'button'>, 'value'> & { value: string | (() => string) }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  const label = copied ? 'Copied' : 'Copy code';
  return (
    <>
      <button
        type="button"
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        aria-label={label}
        title={label}
        className={cx(styles.button, className)}
        onClick={(event) => {
          onClick?.(event);
          const text = typeof value === 'function' ? value() : value;
          navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {});
        }}
        {...props}
      >
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
      <span aria-live="polite" className={styles.srOnly}>{copied ? 'Copied' : ''}</span>
    </>
  );
}

/** Wrap toggle (ours; the shadcn block takes `wrap` as a prop and leaves the control to the app). */
export function CodeBlockWrapButton({ pressed, className, ...props }: Omit<React.ComponentProps<'button'>, 'aria-pressed'> & { pressed: boolean }) {
  return (
    <button type="button" data-slot="code-block-wrap-button" aria-label="Wrap lines" title="Wrap lines" aria-pressed={pressed} className={cx(styles.button, className)} {...props}>
      <WrapText size={16} aria-hidden="true" />
    </button>
  );
}

const sameEdges = (a: Edges, b: Edges) => a.overflow === b.overflow && a.start === b.start && a.end === b.end;
type Edges = { overflow: boolean; start: boolean; end: boolean };

function useScrollEdges(ref: React.RefObject<HTMLPreElement | null>, onOverflowChange?: (overflow: boolean) => void) {
  const report = React.useRef(onOverflowChange);
  report.current = onOverflowChange;
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last: Edges | null = null;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const left = Math.abs(el.scrollLeft);
      const next = { overflow: max > 1, start: max > 1 && left > 1, end: max > 1 && left < max - 1 };
      if (last && sameEdges(last, next)) return;
      const overflowChanged = !last || last.overflow !== next.overflow;
      last = next;
      el.toggleAttribute('data-fade-start', next.start);
      el.toggleAttribute('data-fade-end', next.end);
      el.toggleAttribute('data-overflow-x', next.overflow);
      if (overflowChanged) report.current?.(next.overflow);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', update); observer?.disconnect(); };
  }, [ref]);
}

export function CodeBlockContent({
  className, children, style, wrap = false, lineNumbers = false, startLine = 1, collapsed = false, previewLines = 15, diff = false, onOverflowChange, ref: outerRef, ...props
}: React.ComponentProps<'pre'> & {
  wrap?: boolean;
  lineNumbers?: boolean;
  startLine?: number;
  /** Shows the first `previewLines` lines and fades the rest (the footer's Show more). */
  collapsed?: boolean;
  previewLines?: number;
  /** Leaves room for the +/− markers of added and removed lines. */
  diff?: boolean;
  /** Called when the code starts or stops overflowing horizontally (never while wrapped). */
  onOverflowChange?: (overflow: boolean) => void;
}) {
  const ref = React.useRef<HTMLPreElement>(null);
  React.useImperativeHandle(outerRef, () => ref.current!, []);
  useScrollEdges(ref, onOverflowChange);
  return (
    <pre
      ref={ref}
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      data-numbered={lineNumbers || undefined}
      data-collapsed={collapsed || undefined}
      data-diff={diff || undefined}
      dir="ltr"
      tabIndex={0}
      style={{ counterReset: `line ${startLine - 1}`, ...(collapsed ? { '--preview-lines': previewLines } : {}), ...style } as React.CSSProperties}
      className={cx(styles.content, className)}
      {...props}
    >
      <code data-slot="code-block-code" className={styles.code}>
        {lineNumbers && typeof children === 'string'
          ? children.replace(/\n$/, '').split('\n').map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)
          : children}
      </code>
    </pre>
  );
}

export type CodeBlockLineVariant = 'default' | 'added' | 'removed' | 'highlighted';

export const CodeBlockLine = React.memo(function CodeBlockLine({
  className, variant = 'default', prompt, children, ...props
}: React.ComponentProps<'span'> & { variant?: CodeBlockLineVariant; /** A terminal prompt shown before the line, never selected or copied. */ prompt?: string }) {
  // An empty line holds a newline so copying a selection keeps blank lines.
  const empty = children === undefined || children === null || children === '' || (Array.isArray(children) && children.length === 0);
  return (
    <span data-slot="code-block-line" data-variant={variant} className={cx(styles.line, className)} {...props}>
      <span data-slot="code-block-line-content" className={styles.lineContent}>
        {prompt ? <span className={styles.prompt} aria-hidden="true">{prompt}</span> : null}
        {empty && !prompt ? '\n' : children}
      </span>
    </span>
  );
});

export function CodeBlockFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="code-block-footer" className={cx(styles.footer, className)} {...props} />;
}

/** The footer's Show more / Show less toggle for a collapsed block. */
export function CodeBlockExpandButton({ expanded, hiddenLines, className, ...props }: React.ComponentProps<'button'> & { expanded: boolean; hiddenLines: number }) {
  return (
    <button type="button" data-slot="code-block-expand-button" aria-expanded={expanded} className={cx(styles.more, className)} {...props}>
      <ChevronDown aria-hidden="true" />
      {expanded ? 'Show less' : `Show more (${hiddenLines} ${hiddenLines === 1 ? 'line' : 'lines'})`}
    </button>
  );
}
