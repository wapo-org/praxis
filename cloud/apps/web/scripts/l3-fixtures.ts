// WP-L3 fixtures: the markdown a fake upstream model streams. Test-only; never bundled into the app.

/** The owner's "write something long for formatting test" answer, rebuilt from L-ref/01–07 (about 1,500 tokens). */
export const OWNER_DOC = `# The Ultimate Markdown Formatting Test

> A long-form sample document to test headings, lists, tables, code, quotes, and more.

## Introduction

This is a **long formatting test** designed to exercise *every major* Markdown feature in one place. It is intentionally verbose so you can check wrapping, spacing, scrolling, and readability.

Lorem ipsum dolor sit amet, consectetur adipiscing elit. **Vivamus lacinia** odio vitae vestibulum vestibulum. *Cras vehicula* aliquam enim at blandit. You can use \`inline code\` for short snippets, ~~strikethrough~~ for deletions, and [links](https://example.com) for references.

This paragraph tests **bold**, *italic*, ***bold-italic***, \`monospace\`, <u>underline via HTML</u>, and ==highlight via extension==. The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. 1234567890 !@#$%^&*()_+-=[]{}|;':",./<>? — and the sentence keeps going after the symbols, so a renderer that waits for a closing delimiter would stall right here.

## A Deliberately Long Heading That Wraps Onto A Second Line So We Can See How Headings Behave While They Stream In Token By Token

### Typography & Inline Styles

Emoji sit on the baseline 🚀 ✅ 🎉 next to text, and numbers such as 3.14159, 2,718 and 1e-9 stay aligned. Prices: $5 and $10 are not math. A stray * asterisk and a lone _ underscore stay literal.

#### Level four heading

Paragraph text under a fourth-level heading, with a footnote reference.[^1]

## Lists

1. **Ordered item with everything:**
   - Bullet inside ordered
   - Second bullet with \`code\` and [link](https://example.com)
   > Quote inside a list item to test indentation. Second line of quote.

   \`\`\`js
   // Code inside a list
   console.log("indentation matters");
   \`\`\`
2. Second ordered item with a long line that wraps: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
3. Third item.

- Level 1 - Fruits
  - Level 2 - Citrus
    - Level 3 - Orange
      - Level 4 - Blood Orange
        - Level 5 - Organic Blood Orange
          - Level 6 - Deepest item - should still indent correctly
      - Level 4 - Navel Orange
    - Level 3 - Lemon
  - Level 2 - Berries
    - Level 3 - Blueberry with a very long line to test wrapping when a nested item exceeds one line lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod
- Level 1 - Vegetables

- [x] Task that is done
- [ ] Task that is open
- [ ] Another open task with \`code\`

## Code

\`\`\`python
from dataclasses import dataclass
from typing import List

@dataclass
class Article:
    title: str
    words: int
    tags: List[str]

    def reading_time_minutes(self, wpm: int = 200) -> float:
        return round(self.words / wpm, 1)

articles = [
    Article("Formatting Matters", 1840, ["design", "typography"]),
    Article("Long Reads Win", 3250, ["content", "ux"]),
]

for a in articles:
    print(f"{a.title} — ~{a.reading_time_minutes()} min read, and this line is deliberately long so that it overflows the code box horizontally")
\`\`\`

\`\`\`bash
curl -fsSL https://example.com/install.sh | sh -s -- --prefix "$HOME/.local" --yes
\`\`\`

## Tables

| Feature | Status | Latency (ms) | Notes |
| :--- | :---: | ---: | :--- |
| Streaming | ✅ Ready | 12.5 | Tokens paint within one frame |
| Tables | ✅ Ready | 3.25 | Contained, scroll horizontally |
| Code blocks | ✅ Ready | 118.75 | Highlighted with \`shiki\` |
| Footnotes | ⚠️ Partial | 1,024.00 | Rendered at the end |

## Quotes and rules

> "Typography is the craft of endowing human language with a durable visual form."
>
> — Robert Bringhurst

---

Final checklist:

- No overflowing tables or code on mobile ✅
- Comfortable line-length (65-75 chars) ✅
- Clear hierarchy from H1 to H4 ✅

*Thanks for reading this long formatting test. Now go ship something beautiful.* 🚀

[^1]: The footnote text, which lives at the end of the answer.
`;

/** Every element, for static before/after captures. */
export const FORMATTING_DOC = `# Heading level one

Body paragraph with **bold text**, *italic text*, ***bold italic***, ~~strikethrough~~, \`inline code\`, a [named link](https://example.com/docs), and a bare URL https://example.com/path?q=1. Emoji sit on the baseline 🚀 ✅ 🎉. Привет, это кириллица — она тоже должна выглядеть хорошо. Raw HTML such as <u>underline</u> stays literal, as does ==highlight==, a stray * asterisk and 2 * 3 * 4.

## Heading level two

A second paragraph so the heading spacing is visible. Two inline chips in one line, \`alpha\` and \`beta\`, must not push the lines apart; nor should a chip that wraps at the end of a long line of text such as \`a_rather_long_identifier_name\`.

### Heading level three

Text under level three.

#### Heading level four

Text under level four.

## Nested lists

- Level 1 - Fruits
  - Level 2 - Citrus
    - Level 3 - Orange
      - Level 4 - Blood Orange
        - Level 5 - Organic Blood Orange
          - Level 6 - Deepest item - should still indent correctly
      - Level 4 - Navel Orange
    - Level 3 - Lemon
  - Level 2 - Berries
    - Level 3 - Blueberry with a very long line to test wrapping when a nested item exceeds one line lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod
- Level 1 - Vegetables
  1. Ordered inside unordered
  2. Second ordered
     - Bullet inside ordered inside bullet
     - Another

1. First ordered
2. Second ordered
   1. Nested ordered a
   2. Nested ordered b
      1. Third-level ordered
3. Third ordered
10. Tenth ordered keeps its number aligned

- [x] Done task
- [ ] Open task
  - [ ] Nested open task

## Code inside lists

1. **Ordered item with everything:**
   - Bullet inside ordered
   - Second bullet with \`code\` and [link](https://example.com)
   > Quote inside a list item to test indentation. Second line of quote.

   \`\`\`js
   // Code inside a list
   console.log("indentation matters");
   \`\`\`
2. Second ordered item with table:

   | Key | Value |
   | --- | ---: |
   | a | 1 |
   | b | 22 |

## Code

\`\`\`python
from dataclasses import dataclass
from typing import List

@dataclass
class Article:
    title: str
    words: int
    tags: List[str]

    def reading_time_minutes(self, wpm: int = 200) -> float:
        return round(self.words / wpm, 1)

for a in articles:
    print(f"{a.title} — ~{a.reading_time_minutes()} min read, and this line is deliberately long so that it overflows the code box horizontally and must scroll")
\`\`\`

\`\`\`typescript
export async function loadUsers(signal?: AbortSignal): Promise<User[]> {
  const response = await fetch('/api/users', { signal });
  if (!response.ok) throw new Error(\`Request failed: \${response.status}\`);
  return (await response.json()) as User[];
}
\`\`\`

\`\`\`
Plain fence with no language.
\`\`\`

## Tables

| Feature | Status | Latency (ms) | Notes |
| :--- | :---: | ---: | :--- |
| Streaming | ✅ Ready | 12.5 | Tokens paint within one frame |
| Tables | ✅ Ready | 3.25 | Contained, scroll horizontally |
| Code blocks | ✅ Ready | 118.75 | Highlighted with \`shiki\` |
| Footnotes | ⚠️ Partial | 1,024.00 | Rendered at the end |

| A very wide table | Column two | Column three | Column four | Column five | Column six | Column seven | Column eight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| The quick brown fox | jumps over the lazy dog | 1,234.50 | 9.75 | lorem ipsum dolor | sit amet consectetur | adipiscing elit | sed do eiusmod |

## Quotes, rules, images, footnotes

> "Typography is the craft of endowing human language with a durable visual form."
>
> — Robert Bringhurst

> A quote with a list:
> - one
> - two

---

![A small test image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)

A sentence with a footnote.[^1] And another.[^note]

[^1]: The first footnote.
[^note]: The second footnote, with \`code\`.
`;

export const NESTED_DOC = `# Nested Lists Test

## 1. Deeply Nested Unordered List

- Level 1 - Fruits
  - Level 2 - Citrus
    - Level 3 - Orange
      - Level 4 - Blood Orange
        - Level 5 - Organic Blood Orange
          - Level 6 - Deepest item - should still indent correctly
      - Level 4 - Navel Orange
    - Level 3 - Lemon
      - Level 4 - Meyer Lemon
      - Level 4 - Eureka Lemon
  - Level 2 - Berries
    - Level 3 - Strawberry
    - Level 3 - Blueberry with a very long line to test wrapping when a nested item exceeds one line lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod
- Level 1 - Vegetables
  - Level 2 - Root

## 2. Mixed

1. Ordered
   - Bullet
     1. Ordered again
        - Bullet again
`;

export const REASONING = 'Evaluating system mode instructions and tool policy constraints for API developer context. Then drafting a long formatting document with headings, lists, tables and code.';

/** A filler answer long enough to overflow the viewport several times (scroll-on-send traces). */
export const LONG_PROSE = Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1}. A careful release keeps the reader in control. Check the evidence, name what changed, and keep the next action clear so that nobody has to guess what happens after this step.`).join('\n\n');

export function fixtureFor(prompt: string): { text: string; reasoning?: string } {
  const p = prompt.toLowerCase();
  if (p.includes('nested')) return { text: NESTED_DOC };
  if (p.includes('every element')) return { text: FORMATTING_DOC };
  if (p.includes('long for formatting')) return { text: OWNER_DOC, reasoning: REASONING };
  if (p.includes('long prose')) return { text: LONG_PROSE };
  if (p.includes('thanks')) return { text: "You're welcome! 🎉\n\nLet me know if you want more test content — different lengths, themes, or edge cases." };
  return { text: `Here is a short answer to “${prompt.slice(0, 80)}”. It has two sentences.` };
}

/** Model-like tokens: about four characters, never splitting a surrogate pair. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const pieces = text.match(/\s*\S{1,6}|\s+/gu) ?? [text];
  for (const piece of pieces) out.push(piece);
  return out;
}
