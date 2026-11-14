import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadHighlighter } from '../ui/code-block/highlighter';
import { MarkdownContent } from './MarkdownContent';

const html = (text: string, isStreaming = false) => renderToStaticMarkup(<MarkdownContent text={text} isStreaming={isStreaming} />);
const visible = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe('Streamdown formatting (WP-L3)', () => {
  it('nests six list levels, mixes ordered and unordered, and keeps a fenced block inside an item', () => {
    const nested = Array.from({ length: 6 }, (_, i) => `${'  '.repeat(i)}- Level ${i + 1}`).join('\n');
    const out = html(`${nested}\n\n1. **Ordered item:**\n   - Bullet inside ordered\n\n   \`\`\`js\n   // Code inside a list\n   console.log("indentation matters");\n   \`\`\`\n2. Second`);
    expect(out.match(/<ul/g)).toHaveLength(7);
    expect(out.match(/<ol/g)).toHaveLength(1);
    expect(out).toMatch(/<li>[\s\S]*markdown-code-block[\s\S]*<\/li>/);
    expect(out).toContain('data-language="js"');
    expect(visible(out)).not.toContain('```');
  });
  it('keeps ordered list numbering and table alignment, escaped pipes and ragged rows', () => {
    expect(html('3. three\n4. four')).toContain('<ol start="3">');
    const out = html('| Left | Mid | Right |\n| :--- | :---: | ---: |\n| a \\| b | 2 | 3.50 |\n| short |');
    expect(out).toContain('markdown-table-card');
    expect(out).toMatch(/<th[^>]*style="text-align:center"[^>]*>Mid<\/th>/);
    expect(out).toMatch(/<td[^>]*style="text-align:right"[^>]*>3.50<\/td>/);
    expect(visible(out)).toContain('a | b');
    expect(out.match(/<tr[ >]/g)).toHaveLength(3);
  });
  it('renders tasks, quotes, rules, images and footnotes', () => {
    const out = html('- [x] done\n- [ ] open\n\n> quoted\n\n---\n\n![alt text](https://example.com/a.png)\n\nNote.[^1]\n\n[^1]: The footnote.');
    expect(out.match(/type="checkbox"/g)).toHaveLength(2);
    expect(out).toContain('<blockquote>');
    expect(out).toContain('<hr/>');
    expect(out).toMatch(/<img src="https:\/\/example.com\/a.png" alt="alt text"/);
    expect(out).toContain('data-footnotes');
    expect(out).toContain('data-footnote-backref');
    expect(out).toContain('id="user-content-fnref-1"');
    expect(visible(out)).toContain('The footnote.');
  });
  it('shows raw HTML as text, in prose and in code alike, and hardens links', () => {
    const out = html('<u>literal</u> and ==highlight== and 2 * 3 * 4\n\n`<div>` inline\n\n```html\n<b>x</b>\n```\n\n[unsafe](javascript:alert(1)) [safe](https://example.com)');
    expect(visible(out)).toContain('<u>literal</u> and ==highlight== and 2 * 3 * 4');
    expect(out).not.toContain('<u>');
    expect(visible(out)).toContain('<div> inline');
    expect(visible(out)).toContain('<b>x</b>');
    expect(out).not.toContain('&amp;lt;');
    expect(out).not.toContain('javascript:');
    const safe = out.match(/<a\b[^>]*>safe<\/a>/)?.[0];
    expect(safe).toContain('href="https://example.com/"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer"');
  });
  it('inline code is plain code: no chip button, no inspector (L-ref/01)', () => {
    const out = html('Use `code` and `src/app.ts`.');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('chip-inspector-card');
    expect(out.match(/data-testid="inline-code-pill"/g)).toHaveLength(2);
  });
  // WP-N2: the Wrap toggle is per block and only appears once the block is measured to overflow (n2.pw.ts), so the
  // first render has Copy alone. It used to be on every block, shared through sessionStorage.
  it('code blocks have a language label and a Copy button; Wrap waits until the block overflows', () => {
    const out = html('```python\nprint(1)\n```');
    expect(out).not.toContain('code-wrap-button');
    expect(out).toContain('aria-label="Copy code"');
    expect(out).toContain('data-slot="code-block-header"');
    expect(visible(out)).toContain('python');
  });
  it('shows text inside an unfinished fence without waiting for its closing marker (the stall)', () => {
    const out = html('Before\n\n```js\nconst arriving = true;', true);
    expect(visible(out)).toContain('const arriving = true;');
    expect(out).toContain('markdown-code-block');
  });
  it('never flashes raw markers or loses text while a document streams in, at any prefix', () => {
    const doc = 'Testing **bold across splits**, *italic*, ~~strike~~, `src/a.ts`, and [Docs](https://praxis.dev/docs).\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n| --- | ---: |\n| one | 2 |\n\n- [x] Done\n- Item with **bold**\n  - Nested';
    let previousWords = 0;
    for (let end = 1; end <= doc.length; end++) {
      const prefix = doc.slice(0, end);
      const out = html(prefix, true);
      const text = visible(out);
      expect(text, prefix).not.toMatch(/\*\*|~~|[*`]$/);
      // The prose before an unfinished construct is never withheld.
      const settled = prefix.split('\n\n').slice(0, -1).join(' ').replace(/\(https[^)]*\)/g, ' ').replace(/[^A-Za-z]+/g, ' ').split(' ').filter((w) => w.length >= 4);
      for (const word of settled) expect(text, prefix).toContain(word);
      previousWords = Math.max(previousWords, settled.length);
    }
    expect(previousWords).toBeGreaterThan(5);
  });
  it('never splits an emoji across chunks', () => {
    const emoji = '👩🏽‍💻';
    expect(html(`Hello ${emoji.slice(0, 1)}`, true)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

const F = '```';
const lineVariants = (out: string) => [...out.matchAll(/data-slot="code-block-line" data-variant="(\w+)"/g)].map((m) => m[1]);
describe('code block fence features (WP-N2)', () => {
  beforeAll(async () => { await loadHighlighter(['typescript', 'python', 'bash', 'ansi']); });
  it('title="…" puts the file name in a header', () => {
    const out = html(`${F}ts title="src/app.ts"\nconst a = 1;\n${F}`);
    expect(out).toMatch(/data-slot="code-block-title"[^>]*data-kind="file"[^>]*>.*src\/app\.ts/);
    expect(out).toContain('--shiki-light');
  });
  it('{3,5-7} highlights those lines', () => {
    const out = html(`${F}ts {2,4-5}\na\nb\nc\nd\ne\nf\n${F}`);
    expect(lineVariants(out)).toEqual(['default', 'highlighted', 'default', 'highlighted', 'highlighted', 'default']);
  });
  it('showLineNumbers and startLine=40 number the lines with CSS counters', () => {
    expect(html(`${F}ts showLineNumbers\na\n${F}`)).toMatch(/data-numbered="true"[^>]*style="counter-reset:line 0"/);
    expect(html(`${F}python startLine=40\na\n${F}`)).toMatch(/data-numbered="true"[^>]*style="counter-reset:line 39"/);
    expect(html(`${F}ts\na\n${F}`)).not.toContain('data-numbered');
  });
  it('diff: +/- lines are added/removed, the marker is not text, and the language after diff still highlights', () => {
    const out = html(`${F}diff ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n ok();\n${F}`);
    expect(lineVariants(out)).toEqual(['default', 'removed', 'added', 'default']);
    expect(out).toContain('data-role="meta"');
    expect(out).toContain('data-diff="true"');
    expect(visible(out)).toContain('const a = 1;const a = 2;ok();');
    expect(out).toMatch(/data-variant="added"[\s\S]*?--shiki-light/);
    expect(visible(html(`${F}diff\n-a\n+b\n${F}`))).toContain('ab');
  });
  it('terminal / console / shell-session: $ lines are commands after a prompt, output is muted, ANSI renders', () => {
    for (const language of ['terminal', 'console', 'shell-session']) {
      const out = html(`${F}${language}\n$ npm test\n\u001b[32mok\u001b[0m 3 passed\n${F}`);
      expect(out).toContain('data-kind="terminal"');
      expect(out).toMatch(/data-role="command"[\s\S]*?aria-hidden="true">\$ </);
      expect(out).toContain('data-role="output"');
      expect(out).not.toContain('\u001b');
      expect(out).toMatch(/--shiki-light:#3f6b3a[^"]*">ok</i);
      expect(visible(out)).toContain('Terminal');
    }
  });
  it('ansi renders colours and drops the escape codes', () => {
    const out = html(`${F}ansi\n\u001b[31merror\u001b[0m plain\n${F}`);
    expect(out).toMatch(/--shiki-light:#b3382e[^"]*">error</i);
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('data-slot="code-block-header"');
  });
  it('an ANSI escape still arriving at the end of the streamed text never shows as text', () => {
    for (const tail of ['\u001b', '\u001b[', '\u001b[3', '\u001b[1;3']) {
      const out = html(`${F}ansi\n\u001b[33mwarn\u001b[0m cold\n${tail}`, true);
      expect(visible(out)).not.toMatch(/\[[0-9;]*$|\[\d/);
      expect(out).not.toContain('\u001b');
    }
  });
  it('text is plain, without colours and without a header', () => {
    const out = html(`${F}text\nif (x) { return y; }\n${F}`);
    expect(out).not.toContain('--shiki');
    expect(out).not.toContain('data-slot="code-block-header"');
    expect(out).toContain('data-slot="code-block-actions"');
  });
  it('error, or a title that starts with "Error", is the destructive variant', () => {
    expect(html(`${F}error\nTypeError: x\n${F}`)).toMatch(/data-slot="code-block" data-variant="destructive"/);
    expect(html(`${F}log title="Error: tsc"\nbad\n${F}`)).toMatch(/data-slot="code-block" data-variant="destructive"/);
    expect(html(`${F}ts title="errors.ts"\nok\n${F}`)).toMatch(/data-slot="code-block" data-variant="default"/);
  });
  it('more than 20 lines collapse behind Show more', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
    const out = html(`${F}ts\n${lines(26)}\n${F}`);
    expect(out).toContain('data-collapsed="true"');
    expect(out).toContain('Show more (6 lines)');
    expect(out).toContain('aria-expanded="false"');
    const short = html(`${F}ts\n${lines(20)}\n${F}`);
    expect(short).not.toContain('data-collapsed');
    expect(short).not.toContain('data-slot="code-block-footer"');
  });
});
