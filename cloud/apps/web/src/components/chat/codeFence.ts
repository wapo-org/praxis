import { planFor, resolveLanguage, type CodeBlockLineVariant, type HighlightPlan } from '../ui/code-block';

/**
 * What a fenced block asks for, from its info string (` ```lang meta `). The agent is told this syntax in the system
 * prompt's formatting section (apps/api/src/conversation.ts, FORMATTING_GUIDE); keep the two in step.
 *
 *   ```ts title="src/app.ts" {3,5-7} showLineNumbers startLine=40
 *   ```diff ts            +/- lines are added/removed; `ts` still highlights the code
 *   ```terminal           `$ ` lines are commands, the rest is output (ANSI colours render); also console, shell-session
 *   ```ansi  ```text  ```error
 */
export type FenceKind = 'code' | 'diff' | 'terminal' | 'ansi' | 'text';

export interface Fence {
  kind: FenceKind;
  /** The fence language as written (lower case), or '' for none. */
  language: string;
  /** The grammar's language: the fence language, or for a diff the one after `diff`. */
  codeLanguage: string;
  title?: string;
  /** Header text when there is no title: the language, or nothing (floating actions). */
  label?: string;
  highlight: ReadonlySet<number>;
  lineNumbers: boolean;
  startLine: number;
  destructive: boolean;
}

const TERMINAL = new Set(['terminal', 'console', 'shell-session', 'shellsession']);
const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'error']);

/** Splits the meta into tokens, keeping quoted values (`title="a b"`) and `{1,3-5}` ranges whole. */
function metaTokens(meta: string): string[] {
  return meta.match(/[\w-]+=(?:"[^"]*"|'[^']*'|\S+)|\{[^}]*\}|"[^"]*"|\S+/g) ?? [];
}

function lineRanges(spec: string, into: Set<number>) {
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const from = Number(m[1]), to = Math.min(Number(m[2] ?? m[1]), from + 10_000);
    for (let n = from; n <= to; n++) into.add(n);
  }
}

// A quote still open (the info string is arriving) is dropped rather than shown.
const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, '$2').replace(/^["']/, '');

export function parseFence(rawLanguage: string, meta = ''): Fence {
  const language = rawLanguage.trim().toLowerCase();
  const highlight = new Set<number>();
  let title: string | undefined, lineNumbers = false, startLine = 1, subLanguage = '';
  for (const token of metaTokens(meta)) {
    const pair = /^([\w-]+)=(.*)$/.exec(token);
    if (pair) {
      const key = pair[1]!.toLowerCase(), value = unquote(pair[2]!);
      if (key === 'title' || key === 'filename' || key === 'file') title = value.trim() || undefined;
      else if (key === 'startline' || key === 'start') { const n = Number.parseInt(value, 10); if (Number.isFinite(n) && n > 0) { startLine = n; lineNumbers = true; } }
      else if (key === 'lines' || key === 'highlight') lineRanges(value.replace(/^\{|\}$/g, ''), highlight);
    } else if (token.startsWith('{')) lineRanges(token.slice(1, -1), highlight);
    else if (/^showlinenumbers(\{\d+\})?$/i.test(token)) {
      lineNumbers = true;
      const n = /\{(\d+)\}/.exec(token)?.[1];
      if (n && Number(n) > 0) startLine = Number(n);
    } else if (/^["']/.test(token) && !title) title = unquote(token).trim() || undefined;
    else if (!subLanguage && /^[\w+#.-]+$/.test(token)) subLanguage = token.toLowerCase();
  }
  const kind: FenceKind = language === 'diff' || language === 'patch' ? 'diff'
    : TERMINAL.has(language) ? 'terminal'
      : language === 'ansi' ? 'ansi'
        : PLAIN.has(language) ? 'text' : 'code';
  const destructive = language === 'error' || /^error\b/i.test(title ?? '');
  const codeLanguage = kind === 'diff' ? subLanguage : kind === 'code' ? language : kind === 'ansi' ? 'ansi' : '';
  const label = title ? undefined
    : kind === 'terminal' ? 'Terminal'
      : language === 'error' ? 'Error'
        : kind === 'code' || kind === 'diff' ? (kind === 'diff' && subLanguage ? `diff · ${subLanguage}` : language)
          : undefined;
  return { kind, language, codeLanguage, title, label, highlight, lineNumbers, startLine, destructive };
}

export interface FenceLine {
  text: string;
  variant: CodeBlockLineVariant;
  /** `meta`: a diff's hunk or file header; `command` / `output`: a terminal's lines. */
  role?: 'meta' | 'command' | 'output';
  prompt?: string;
}

const DIFF_META = /^(?:@@|diff --git |index [0-9a-f]|\+\+\+(?: |$)|---(?: |$)|new file mode|deleted file mode|similarity index|rename (?:from|to) )/;
const PROMPT = /^\$(?: |$)/;
// CSI and OSC escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

/** The display lines of a block: diff markers and prompts move out of the text into the line's variant / prompt. */
export function fenceLines(code: string, fence: Fence): FenceLine[] {
  const lines = code.split('\n');
  return lines.map((line, i) => {
    const highlighted = fence.highlight.has(i + 1);
    if (fence.kind === 'diff') {
      if (DIFF_META.test(line)) return { text: line, variant: highlighted ? 'highlighted' : 'default', role: 'meta' };
      const mark = line[0];
      if (mark === '+') return { text: line.slice(1), variant: 'added' };
      if (mark === '-') return { text: line.slice(1), variant: 'removed' };
      return { text: mark === ' ' ? line.slice(1) : line, variant: highlighted ? 'highlighted' : 'default' };
    }
    if (fence.kind === 'terminal') {
      if (PROMPT.test(line)) return { text: line.slice(2), variant: highlighted ? 'highlighted' : 'default', role: 'command', prompt: '$ ' };
      return { text: line, variant: highlighted ? 'highlighted' : 'default', role: 'output' };
    }
    return { text: line, variant: highlighted ? 'highlighted' : 'default' };
  });
}

/** How the block's lines are coloured. A terminal's commands are shell, its output ANSI. */
export function fencePlan(fence: Fence, lines: () => readonly FenceLine[]): HighlightPlan {
  if (fence.kind === 'terminal') {
    return { key: 'terminal', languages: ['bash', 'ansi'], lineLanguage: (i) => (lines()[i]?.role === 'command' ? 'bash' : 'ansi') };
  }
  if (fence.kind === 'diff' && !resolveLanguage(fence.codeLanguage)) return { key: '', languages: [] };
  return planFor(fence.codeLanguage);
}

/** What the copy button copies: the code as written; a terminal's commands only; ANSI without its escapes. */
export function copyText(code: string, fence: Fence): string {
  if (fence.kind === 'terminal') {
    const commands = code.split('\n').filter((line) => PROMPT.test(line)).map((line) => line.slice(2));
    return commands.length ? commands.join('\n') : stripAnsi(code);
  }
  if (fence.kind === 'ansi' || fence.kind === 'text') return stripAnsi(code);
  return code;
}
