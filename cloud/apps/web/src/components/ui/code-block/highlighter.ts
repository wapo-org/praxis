import { createHighlighterCore, type GrammarState, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { praxisDark, praxisLight } from '../../chat/codeThemes';

/**
 * Shiki for code blocks (port of shadcn's `lib/highlighter`). One core highlighter with the praxis themes and the
 * JavaScript regex engine; each grammar is its own chunk, loaded the first time a block uses it. Once a language is
 * loaded, highlighting is synchronous, so a block re-renders with its colours in the same frame as its text.
 */
const grammars = {
  bash: () => import('shiki/langs/shellscript.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};
type Grammar = keyof typeof grammars;
export type Language = Grammar | 'ansi';

const aliases: Record<string, Grammar> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript', py: 'python',
  sh: 'bash', shell: 'bash', shellscript: 'bash', zsh: 'bash', yml: 'yaml', rs: 'rust',
};

/** The grammar for a fence language, or null for one that is shown as plain text. */
export function resolveLanguage(language: string): Language | null {
  const name = language.trim().toLowerCase();
  if (name === 'ansi') return 'ansi';
  if (name in grammars) return name as Grammar;
  return aliases[name] ?? null;
}

const THEMES = { light: praxisLight.name, dark: praxisDark.name };
let core: Promise<HighlighterCore> | undefined;
let ready: HighlighterCore | undefined;
const loaded = new Set<Language>(['ansi']);
const loading = new Map<Language, Promise<void>>();

function getCore() {
  core ??= createHighlighterCore({ themes: [praxisLight, praxisDark], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })
    .then((h) => { ready = h; return h; });
  return core;
}

export type HighlightedLine = ThemedToken[];
export interface Highlighter {
  /** Tokens per line, and the grammar state after the last line; pass it back to continue where the code left off. */
  highlight(code: string, language: Language, state?: GrammarState): { lines: HighlightedLine[]; state?: GrammarState };
}

// ANSI text without a colour code comes back in the theme's foreground; it inherits the block's colour instead, so a
// terminal's output stays muted around the coloured parts.
function plainDefaults(tokens: ThemedToken[]): ThemedToken[] {
  for (const token of tokens) {
    const style = token.htmlStyle as Record<string, string> | undefined;
    if (style && Object.keys(style).length === 2 && style['--shiki-light']?.toLowerCase() === praxisLight.fg && style['--shiki-dark']?.toLowerCase() === praxisDark.fg) delete token.htmlStyle;
  }
  return tokens;
}

// eslint-disable-next-line no-control-regex
const PARTIAL_ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*)?$/;

/** How much text has been tokenized (tests assert that streaming tokenizes only new lines). */
export const highlightStats = { calls: 0, chars: 0 };

function wrap(shiki: HighlighterCore): Highlighter {
  return {
    highlight(code, language, state) {
      highlightStats.calls++;
      highlightStats.chars += code.length;
      // ANSI has no grammar state: each line is tokenized alone, so it has the same colours streamed or whole.
      if (language === 'ansi') {
        // An escape sequence still arriving at the end of a line is held back, never shown as text for a frame.
        return { lines: code.split('\n').map((line) => plainDefaults(shiki.codeToTokens(line.replace(PARTIAL_ESCAPE, ''), { lang: 'ansi', themes: THEMES, defaultColor: false }).tokens[0] ?? [])) };
      }
      const result = shiki.codeToTokens(code, { lang: language, themes: THEMES, defaultColor: false, ...(state ? { grammarState: state } : {}) });
      return { lines: result.tokens, state: result.grammarState ?? shiki.getLastGrammarState(result.tokens) };
    },
  };
}

/** The highlighter, synchronously, when the core and every language are already loaded. */
export function peekHighlighter(languages: readonly Language[]): Highlighter | null {
  return ready && languages.every((l) => loaded.has(l)) ? wrap(ready) : null;
}

/** Loads the core and the languages; resolves to a highlighter for them. */
export async function loadHighlighter(languages: readonly Language[]): Promise<Highlighter> {
  const shiki = await getCore();
  await Promise.all(languages.filter((l) => !loaded.has(l)).map((language) => {
    let pending = loading.get(language);
    if (!pending) {
      pending = shiki.loadLanguage(grammars[language as Grammar]).then(() => { loaded.add(language); });
      loading.set(language, pending);
    }
    return pending;
  }));
  return wrap(shiki);
}
