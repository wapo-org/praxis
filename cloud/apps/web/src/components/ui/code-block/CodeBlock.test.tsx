// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockFooter, CodeBlockHeader, CodeBlockLine, CodeBlockTitle, useHighlightedCode } from '.';
import { highlightStats, loadHighlighter } from './highlighter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
const mount = (node: React.ReactNode) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(node)); };
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
beforeAll(async () => { await loadHighlighter(['typescript', 'bash', 'ansi']); });

function Highlighted({ code, language }: { code: string; language: string }) {
  const lines = useHighlightedCode(code, language);
  return <CodeBlock><CodeBlockContent>{lines.map((line, i) => <CodeBlockLine key={i}>{line}</CodeBlockLine>)}</CodeBlockContent></CodeBlock>;
}

describe('CodeBlock (shadcn port, WP-N2)', () => {
  it('keeps the shadcn parts and data hooks: slots, variant, size, ltr focusable content, line counter start', () => {
    const out = renderToStaticMarkup(
      <CodeBlock variant="destructive" size="sm">
        <CodeBlockHeader><CodeBlockTitle>src/app.ts</CodeBlockTitle><CodeBlockActions><CodeBlockCopyButton value="x" /></CodeBlockActions></CodeBlockHeader>
        <CodeBlockContent lineNumbers startLine={40} wrap>{'a\nb\n'}</CodeBlockContent>
        <CodeBlockFooter>footer</CodeBlockFooter>
      </CodeBlock>,
    );
    for (const slot of ['code-block', 'code-block-header', 'code-block-title', 'code-block-actions', 'code-block-copy-button', 'code-block-content', 'code-block-code', 'code-block-line', 'code-block-footer']) expect(out).toContain(`data-slot="${slot}"`);
    expect(out).toContain('data-variant="destructive"');
    expect(out).toContain('data-size="sm"');
    expect(out).toMatch(/<pre[^>]*dir="ltr"[^>]*tabindex="0"/);
    expect(out).toContain('counter-reset:line 39');
    expect(out).toContain('data-numbered="true"');
    expect(out).toContain('data-wrap="true"');
    // A trailing newline is not an extra line; numbers are CSS counters, not text.
    expect(out.match(/data-slot="code-block-line"/g)).toHaveLength(2);
    expect(out).not.toMatch(/>40</);
  });

  it('an empty line holds a newline so a copied selection keeps blank lines', () => {
    mount(<CodeBlock><CodeBlockContent lineNumbers>{'one\n\nthree'}</CodeBlockContent></CodeBlock>);
    expect(host.querySelector('code')!.textContent).toBe('one\nthree');
    expect(host.querySelectorAll('[data-slot=code-block-line-content]')[1]!.textContent).toBe('\n');
  });

  it('the copy button copies its value, turns into a check for 2 s and announces it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.useFakeTimers();
    mount(<CodeBlock><CodeBlockActions><CodeBlockCopyButton value={() => 'copied text'} /></CodeBlockActions></CodeBlock>);
    const button = host.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Copy code');
    await act(async () => { button.click(); });
    expect(writeText).toHaveBeenCalledWith('copied text');
    expect(button.getAttribute('aria-label')).toBe('Copied');
    expect(button.hasAttribute('data-copied')).toBe(true);
    expect(host.querySelector('[aria-live=polite]')!.textContent).toBe('Copied');
    act(() => { vi.advanceTimersByTime(1999); });
    expect(button.getAttribute('aria-label')).toBe('Copied');
    act(() => { vi.advanceTimersByTime(1); });
    expect(button.getAttribute('aria-label')).toBe('Copy code');
    expect(host.querySelector('[aria-live=polite]')!.textContent).toBe('');
  });

  it('highlights with the praxis themes as two-theme CSS variables, synchronously once the grammar is loaded', () => {
    const out = renderToStaticMarkup(<Highlighted code={'const x = 1; // note\nexport function f() {}'} language="ts" />);
    expect(out).toMatch(/style="--shiki-light:#8a3b5e;--shiki-dark:#e39ab8"/i);
    expect(out).toContain('--shiki-light-font-style');
    expect(out.match(/data-slot="code-block-line"/g)).toHaveLength(2);
  });

  it('a language without a grammar is plain text', () => {
    const out = renderToStaticMarkup(<Highlighted code={'plain <b>text</b>'} language="kotlin-ish" />);
    expect(out).not.toContain('--shiki');
    expect(out).toContain('plain &lt;b&gt;text&lt;/b&gt;');
  });

  it('while streaming, tokenizes only the lines that are new, never the whole block per frame', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `export const value${i} = compute(${i}, 'label-${i}'); // line ${i + 1}`);
    const full = lines.join('\n');
    mount(<Highlighted code="" language="ts" />);
    highlightStats.calls = 0;
    highlightStats.chars = 0;
    for (let end = 4; end <= full.length; end += 4) act(() => root!.render(<Highlighted code={full.slice(0, end)} language="ts" />));
    act(() => root!.render(<Highlighted code={full} language="ts" />));
    expect(host.querySelectorAll('[data-slot=code-block-line]')).toHaveLength(60);
    // Each frame re-tokenizes the line being written plus the lines that completed since; never the whole block.
    const renders = Math.ceil(full.length / 4);
    const perRenderTail = full.length / 60;
    expect(highlightStats.chars).toBeLessThan(full.length + renders * perRenderTail * 2.2);
    expect(highlightStats.chars).toBeLessThan(full.length * 30);
  });
});
