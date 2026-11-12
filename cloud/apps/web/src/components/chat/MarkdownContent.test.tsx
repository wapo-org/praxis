import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
  it('code blocks have a language label and icon buttons for Wrap (a toggle) and Copy', () => {
    const out = html('```python\nprint(1)\n```');
    expect(out).toMatch(/data-testid="code-wrap-button"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-testid="code-wrap-button"/);
    expect(out).toContain('aria-label="Copy code"');
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
