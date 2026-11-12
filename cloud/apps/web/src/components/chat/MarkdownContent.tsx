import React from 'react';
import { Streamdown, defaultRehypePlugins, useIsCodeFenceIncomplete, type Components, type HighlightResult } from 'streamdown';
import { createCodePlugin } from '@streamdown/code';
import { WrapText } from 'lucide-react';
import { Check, Copy } from '../../lib/icons';
import { praxisDark, praxisLight } from './codeThemes';
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

// Shiki through Streamdown's plugin. Grammars load on first use; other languages are plain text.
const LANGUAGES = new Set(['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'json', 'css', 'html', 'xml', 'python', 'py', 'bash', 'sh', 'shell', 'zsh', 'swift', 'sql', 'yaml', 'yml', 'diff', 'go', 'rust', 'rs']);
const THEMES: [typeof praxisLight, typeof praxisDark] = [praxisLight, praxisDark];
const shiki = createCodePlugin({ themes: THEMES });
const plugins = {
  code: { ...shiki, highlight: (options: Parameters<typeof shiki.highlight>[0], done?: Parameters<typeof shiki.highlight>[1]) => (LANGUAGES.has(options.language.toLowerCase()) ? shiki.highlight(options, done) : null) },
};

// A soft fade for new words only: it starts on arrival (never later) and runs on the compositor (opacity only).
// The keyframes are `sd-praxisIn` in MarkdownContent.module.css; reduced motion turns it off there.
const ANIMATION = { animation: 'praxisIn', duration: 200, easing: 'var(--ease-standard)', stagger: 0, maxBacklogMs: 0 } as const;

const WRAP_KEY = 'praxis-code-wrap';
const readWrap = () => { try { return sessionStorage.getItem(WRAP_KEY) === 'true'; } catch { return false; } };
const wrapListeners = new Set<(wrap: boolean) => void>();

type Token = { content: string; color?: string; htmlStyle?: Record<string, string> };

/** Highlighted lines for the code that is current. A result for an earlier prefix colours the lines it covers. */
function useHighlight(code: string, language: string, incomplete: boolean) {
  const [result, setResult] = React.useState<{ code: string; tokens: Token[][] } | null>(null);
  React.useEffect(() => {
    let live = true;
    const done = (r: HighlightResult) => { if (live) setResult({ code, tokens: r.tokens as Token[][] }); };
    const sync = plugins.code.highlight({ code, language: language as Parameters<typeof shiki.highlight>[0]['language'], isIncomplete: incomplete, themes: THEMES }, done);
    if (sync) done(sync);
    return () => { live = false; };
  }, [code, language, incomplete]);
  return result && code.startsWith(result.code) ? result : null;
}

function FencedCode({ code, language }: { code: string; language: string }) {
  const incomplete = useIsCodeFenceIncomplete();
  const [wrap, setWrap] = React.useState(readWrap);
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => { wrapListeners.add(setWrap); return () => { wrapListeners.delete(setWrap); clearTimeout(timer.current); }; }, []);
  const highlighted = useHighlight(code, language, incomplete);
  const lines = code.split('\n');
  // The last highlighted line may still be growing; it is re-coloured when its result arrives.
  const coloured = highlighted ? Math.min(highlighted.tokens.length, lines.length) - (highlighted.code === code ? 0 : 1) : 0;
  const toggleWrap = () => {
    const next = !wrap;
    try { sessionStorage.setItem(WRAP_KEY, String(next)); } catch { /* private mode */ }
    for (const set of wrapListeners) set(next);
  };
  const copyCode = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className={styles.code} data-testid="markdown-code-block" data-wrap={wrap} data-language={language || undefined}>
      <div className={styles.codeHeader}>
        <span className={styles.codeLanguage}>{language || 'text'}</span>
        <span className={styles.codeActions}>
          <button type="button" data-testid="code-wrap-button" aria-label="Wrap lines" title="Wrap lines" aria-pressed={wrap} onClick={toggleWrap}>
            <WrapText size={16} aria-hidden="true" />
          </button>
          <button type="button" data-testid="code-copy-button" aria-label={copied ? 'Copied' : 'Copy code'} title={copied ? 'Copied' : 'Copy code'} onClick={copyCode}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </span>
      </div>
      <pre className={styles.codeBody} tabIndex={0}>
        <code>
          {lines.map((line, i) => (
            <span key={i} className={styles.codeLine}>
              {i < coloured
                ? highlighted!.tokens[i]!.map((t, j) => <span key={j} style={{ '--c': t.htmlStyle?.color ?? t.color, '--cd': t.htmlStyle?.['--shiki-dark'] } as React.CSSProperties}>{t.content}</span>)
                : line}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

const textOf = (node: React.ReactNode): string => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : React.isValidElement<{ children?: React.ReactNode }>(node) ? textOf(node.props.children) : '');

const components: Components = {
  code: ({ node: _node, children, className, ...props }) => ('data-block' in props
    ? <FencedCode code={textOf(children).replace(/\n$/, '')} language={/language-(\S+)/.exec(className ?? '')?.[1] ?? ''} />
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
    <Streamdown className={styles.prose} components={components} plugins={plugins} rehypePlugins={rehypePlugins} controls={false}
      lineNumbers={false} isAnimating={isStreaming} parseIncompleteMarkdown={isStreaming} animated={isStreaming ? ANIMATION : false}>
      {source}
    </Streamdown>
  );
});
