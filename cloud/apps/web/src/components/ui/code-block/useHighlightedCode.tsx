import React from 'react';
import type { GrammarState } from 'shiki/core';
import { loadHighlighter, peekHighlighter, resolveLanguage, type Highlighter, type HighlightedLine, type Language } from './highlighter';

/**
 * Highlighted lines for a code block (port of shadcn's `useHighlightedCode`). While the code streams, only the lines
 * that completed since the last render are tokenized, continuing from the grammar state of the line before; the line
 * that is still being written is tokenized on every render. Finished lines keep the same React nodes, so a frame that
 * adds a few characters re-renders one line, not the block.
 */

/** How each line is coloured: one grammar for the block, or one per line (a terminal's commands and output). */
export interface HighlightPlan {
  /** Identity of the plan: a different key starts over. */
  key: string;
  languages: readonly Language[];
  /** Per-line language; when set, every line is tokenized on its own, without grammar state. */
  lineLanguage?: (index: number) => Language | null;
}

export function planFor(language: string): HighlightPlan {
  const lang = resolveLanguage(language);
  return { key: lang ?? '', languages: lang ? [lang] : [] };
}

function nodes(tokens: HighlightedLine | undefined): React.ReactNode {
  if (!tokens?.length) return '';
  return tokens.map((t, i) => (t.htmlStyle ? <span key={i} style={t.htmlStyle as React.CSSProperties}>{t.content}</span> : t.content));
}

type Done = { key: string; highlighter: Highlighter | null; text: string; count: number; lines: React.ReactNode[]; state?: GrammarState };
const EMPTY: Done = { key: '', highlighter: null, text: '', count: 0, lines: [] };

function tokenize(highlighter: Highlighter, plan: HighlightPlan, lines: readonly string[], from: number, state: GrammarState | undefined) {
  if (plan.lineLanguage) {
    return {
      lines: lines.map((line, i) => {
        const lang = plan.lineLanguage!(from + i);
        return lang ? nodes(highlighter.highlight(line, lang).lines[0]) : line;
      }),
      state: undefined,
    };
  }
  const lang = plan.languages[0];
  if (!lang) return { lines: [...lines], state: undefined };
  const result = highlighter.highlight(lines.join('\n'), lang, state);
  return { lines: result.lines.map(nodes), state: result.state };
}

/** One React node per line of `lines` (already split; a block's display text, without diff markers or prompts). */
export function useHighlightedLines(lines: readonly string[], plan: HighlightPlan): React.ReactNode[] {
  const [loaded, setLoaded] = React.useState<{ key: string; highlighter: Highlighter } | null>(() => {
    const now = plan.languages.length ? peekHighlighter(plan.languages) : null;
    return now ? { key: plan.key, highlighter: now } : null;
  });
  const highlighter = loaded?.key === plan.key ? loaded.highlighter : null;
  const { key, languages } = plan;

  React.useEffect(() => {
    if (!languages.length || highlighter) return;
    let cancelled = false;
    const now = peekHighlighter(languages);
    if (now) { setLoaded({ key, highlighter: now }); return; }
    loadHighlighter(languages).then((next) => { if (!cancelled) setLoaded({ key, highlighter: next }); }).catch(() => {});
    return () => { cancelled = true; };
    // `languages` belongs to `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, highlighter]);

  const [done, setDone] = React.useState<Done>(EMPTY);
  const complete = Math.max(0, lines.length - 1);
  let next = done;
  if (next.key !== key || next.highlighter !== highlighter || next.count > complete || !prefixMatches(lines, next)) next = { ...EMPTY, key, highlighter };
  if (highlighter && complete > next.count) {
    const fresh = lines.slice(next.count, complete);
    const result = tokenize(highlighter, plan, fresh, next.count, next.state);
    next = { key, highlighter, text: joinLines(lines, complete), count: complete, lines: [...next.lines, ...result.lines], state: result.state };
  }
  if (next !== done) setDone(next);

  const tail = lines[lines.length - 1] ?? '';
  // Callers memoise `lines` and `plan`; a re-render without new text returns the same nodes.
  return React.useMemo(() => {
    if (!highlighter) return [...lines];
    return [...next.lines, tokenize(highlighter, plan, [tail], complete, next.state).lines[0]];
  }, [highlighter, next, lines, plan, tail, complete]);
}

function joinLines(lines: readonly string[], count: number) {
  let text = '';
  for (let i = 0; i < count; i++) text += lines[i] + '\n';
  return text;
}

function prefixMatches(lines: readonly string[], done: Done) {
  if (!done.count) return true;
  return joinLines(lines, done.count) === done.text;
}

/** shadcn's hook: one node per line of `value` in `language` (plain text for a language without a grammar). */
export function useHighlightedCode(value: string, language: string): React.ReactNode[] {
  // A trailing newline would render as an extra empty line.
  const code = value.endsWith('\n') ? value.slice(0, -1) : value;
  const plan = React.useMemo(() => planFor(language), [language]);
  const lines = React.useMemo(() => code.split('\n'), [code]);
  return useHighlightedLines(lines, plan);
}
