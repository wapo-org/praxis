import React from 'react';
import { Streamdown, defaultRehypePlugins, type Components } from 'streamdown';
import { CircleAlert, SquareTerminal } from 'lucide-react';
import { FileText } from '../../lib/icons';
import {
  CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockExpandButton, CodeBlockFooter, CodeBlockHeader,
  CodeBlockLine, CodeBlockTitle, CodeBlockWrapButton, useHighlightedLines,
} from '../ui/code-block';
import { copyText, fenceLines, fencePlan, parseFence, type Fence } from './codeFence';
import { holdScrollPosition } from './Fold';
import 'streamdown/styles.css';
import styles from './MarkdownContent.module.css';

/**
 * Assistant markdown on Streamdown (WP-L3). Streamdown splits the text into blocks and memoises each one, so a
 * finished block never re-renders as tokens arrive; `remend` closes unterminated syntax while live instead of
 * withholding it. What Streamdown styles with Tailwind (which this app does not generate) is rendered here.
 */

// Raw HTML is shown as text, never rendered: without rehype-raw Streamdown escapes it (`<u>…</u>` stays literal).
// Sanitising and URL hardening still run. `==highlight==` is not markdown and stays literal too.
const rehypePlugins = Object.entries(defaultRehypePlugins).filter(([name]) => name !== 'raw').map(([, plugin]) => plugin);

// A soft fade for new words only: it starts on arrival (never later) and runs on the compositor (opacity only).
// The keyframes are `sd-praxisIn` in MarkdownContent.module.css; reduced motion turns it off there.
const ANIMATION = { animation: 'praxisIn', duration: 200, easing: 'var(--ease-standard)', stagger: 0, maxBacklogMs: 0 } as const;

const COLLAPSE_AFTER = 20;
const PREVIEW_LINES = 20; // = COLLAPSE_AFTER: a block that reaches the limit while streaming never shrinks

/** The element that scrolls `el`: the chat viewport, else the nearest scrolling ancestor, else the page. */
function scrollerOf(el: Element): HTMLElement | null {
  const viewport = el.closest<HTMLElement>('[data-testid="chat-scroll-viewport"]');
  if (viewport) return viewport;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * Keeps an element where it is on screen across the block's next layout (N-ref/04): a block that changes height moves
 * the content below it, never the content above. It also tells the chat's scroll follower to stop pinning.
 */
function useKeepOnScreen() {
  const pending = React.useRef<{ el: Element; top: number } | null>(null);
  React.useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const fix = () => {
      if (!p.el.isConnected) return;
      const delta = p.el.getBoundingClientRect().top - p.top;
      const scroller = Math.abs(delta) >= 0.5 ? scrollerOf(p.el) : null;
      if (scroller) scroller.scrollTop += delta;
    };
    fix();
    // Once more after the frame's resize observers (the scroll follower, the block's own edges) have run.
    requestAnimationFrame(fix);
  });
  return React.useCallback((el: Element | null) => {
    if (!el) return;
    holdScrollPosition(el);
    pending.current = { el, top: el.getBoundingClientRect().top };
  }, []);
}

function FenceTitle({ fence }: { fence: Fence }) {
  if (fence.title) {
    const Icon = fence.destructive ? CircleAlert : fence.kind === 'terminal' ? SquareTerminal : FileText;
    return <CodeBlockTitle data-kind="file" title={fence.title}><Icon aria-hidden="true" /><span>{fence.title}</span></CodeBlockTitle>;
  }
  if (fence.kind === 'terminal') return <CodeBlockTitle><SquareTerminal aria-hidden="true" /><span>Terminal</span></CodeBlockTitle>;
  if (fence.language === 'error') return <CodeBlockTitle><CircleAlert aria-hidden="true" /><span>Error</span></CodeBlockTitle>;
  return <CodeBlockTitle data-kind="language">{fence.label}</CodeBlockTitle>;
}

/** A fenced block from the model: the fence's info string picks the features (codeFence.ts). Wrap is per block. */
function FencedCode({ code, language, meta }: { code: string; language: string; meta: string }) {
  const fence = React.useMemo(() => parseFence(language, meta), [language, meta]);
  const lines = React.useMemo(() => fenceLines(code, fence), [code, fence]);
  const current = React.useRef(lines);
  current.current = lines;
  const plan = React.useMemo(() => fencePlan(fence, () => current.current), [fence]);
  const texts = React.useMemo(() => lines.map((l) => l.text), [lines]);
  const highlighted = useHighlightedLines(texts, plan);
  const [wrap, setWrap] = React.useState(false);
  const [overflow, setOverflow] = React.useState(false);
  // While wrapped nothing overflows; keep what was measured unwrapped so the toggle stays put (and keeps focus).
  const wrapped = React.useRef(wrap);
  wrapped.current = wrap;
  const onOverflowChange = React.useCallback((next: boolean) => { if (!wrapped.current) setOverflow(next); }, []);
  const [expanded, setExpanded] = React.useState(false);
  const keep = useKeepOnScreen();
  const root = React.useRef<HTMLDivElement>(null);
  const collapsible = lines.length > COLLAPSE_AFTER;
  const collapsed = collapsible && !expanded;
  const actions = (
    <CodeBlockActions>
      {wrap || overflow ? (
        <CodeBlockWrapButton data-testid="code-wrap-button" pressed={wrap} onClick={(e) => { keep(e.currentTarget); setWrap(!wrap); }} />
      ) : null}
      <CodeBlockCopyButton data-testid="code-copy-button" value={() => copyText(code, fence)} />
    </CodeBlockActions>
  );
  const header = fence.title || fence.label;
  return (
    <CodeBlock ref={root} variant={fence.destructive ? 'destructive' : 'default'} data-testid="markdown-code-block" data-wrap={wrap} data-language={fence.language || undefined} data-kind={fence.kind}>
      {header ? <CodeBlockHeader><FenceTitle fence={fence} />{actions}</CodeBlockHeader> : actions}
      <CodeBlockContent wrap={wrap} lineNumbers={fence.lineNumbers} startLine={fence.startLine} diff={fence.kind === 'diff'} collapsed={collapsed} previewLines={PREVIEW_LINES} onOverflowChange={onOverflowChange}>
        {lines.map((line, i) => (
          <CodeBlockLine key={i} variant={line.variant} prompt={line.prompt} data-role={line.role}>{highlighted[i]}</CodeBlockLine>
        ))}
      </CodeBlockContent>
      {collapsible ? (
        <CodeBlockFooter>
          <CodeBlockExpandButton
            data-testid="code-expand-button"
            expanded={expanded}
            hiddenLines={lines.length - PREVIEW_LINES}
            onClick={(e) => {
              const block = root.current;
              const scroller = block ? scrollerOf(block) : null;
              // Expanding grows the block downwards; collapsing keeps the button under the pointer when the block's
              // start is already above the fold.
              const fold = !scroller || scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
              const offTop = !!block && block.getBoundingClientRect().top < fold;
              keep(expanded && offTop ? e.currentTarget : block);
              setExpanded(!expanded);
            }}
          />
        </CodeBlockFooter>
      ) : null}
    </CodeBlock>
  );
}

const textOf = (node: React.ReactNode): string => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : React.isValidElement<{ children?: React.ReactNode }>(node) ? textOf(node.props.children) : '');

const components: Components = {
  // Streamdown's codeMeta step keeps the fence's info string after the language as `metastring`.
  code: ({ node: _node, children, className, ...props }) => ('data-block' in props
    ? <FencedCode code={textOf(children).replace(/\n$/, '')} language={/language-(\S+)/.exec(className ?? '')?.[1] ?? ''} meta={String((props as { metastring?: unknown }).metastring ?? '')} />
    : <code data-testid="inline-code-pill">{children}</code>),
  a: ({ node: _node, children, href, ...props }) => {
    if (!href || href === 'streamdown:incomplete-link') return <span data-incomplete-link="">{children}</span>;
    if (href.startsWith('#')) {
      return <a {...props} href={href}>{'data-footnote-backref' in props ? '↩︎' : children}</a>;
    }
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  strong: ({ node: _node, children }) => <strong>{children}</strong>,
  img: ({ node: _node, src, alt }) => (typeof src === 'string' && src && !src.startsWith('streamdown:') ? <img src={src} alt={alt ?? ''} loading="lazy" /> : null),
  table: ({ node: _node, children }) => <div className={styles.table} data-testid="markdown-table-card" tabIndex={0}><table>{children}</table></div>,
  li: ({ node: _node, children, className }) => <li className={className}>{children}</li>,
  ul: ({ node: _node, children, className }) => <ul className={className}>{children}</ul>,
  ol: ({ node: _node, children, className, start }) => <ol className={className} start={start}>{children}</ol>,
  blockquote: ({ node: _node, children }) => <blockquote>{children}</blockquote>,
  hr: () => <hr />,
};

export const MarkdownContent = React.memo(function MarkdownContent({ text, isStreaming = false }: { text: string; isStreaming?: boolean }) {
  // While live, two things wait for the next chunk: half a surrogate pair, and a bare run of up to three marker
  // characters at the very end (`**`, `~~`, a backtick), which remend cannot yet tell from literal text. Both are a
  // few characters for one chunk; everything before them is shown.
  const source = isStreaming ? text.replace(/[\uD800-\uDBFF]$/, '').replace(/[*_~`]{1,3}$/, '') : text;
  return (
    <Streamdown className={styles.prose} components={components} rehypePlugins={rehypePlugins} controls={false}
      lineNumbers={false} isAnimating={isStreaming} parseIncompleteMarkdown={isStreaming} animated={isStreaming ? ANIMATION : false}>
      {source}
    </Streamdown>
  );
});
