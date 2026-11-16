import ts from 'typescript';

/** A longer comment almost always says something the code does not. */
const NARRATION_WORDS_MAX = 8;
const DIRECTIVE = /@ts-|eslint|oxlint|biome-ignore|prettier-ignore|(?:v8|c8|istanbul)\s+ignore|@vite-ignore|TODO|FIXME|https?:/i;
const LEADING_VERBS = new Set([
  'set', 'get', 'return', 'call', 'create', 'loop', 'iterate', 'increment', 'decrement', 'import', 'export', 'define',
  'declare', 'initialize', 'init', 'assign', 'check', 'add', 'remove', 'update', 'delete', 'fetch', 'save', 'load',
  'parse', 'render', 'handle', 'throw', 'await', 'log',
]);
const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'in', 'on', 'is', 'are', 'and', 'or', 'if', 'with', 'from', 'this', 'that', 'it',
  'its', 'by', 'as', 'into', 'each', 'all', 'over', 'then', 'new', 'value', 'variable', 'function', 'method', 'const',
  'here', 'we', 'now', 'be',
]);

function singular(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/** `getUserId` and `user_id` both yield `get`, `user`, `id`. */
function words(text) {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);
}

function singleLineComments(source, text) {
  const ranges = new Map();
  const visit = (node) => {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) ranges.set(range.pos, range);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...ranges.values()];
}

function narrates(comment, code) {
  if (DIRECTIVE.test(comment)) return false;
  const all = words(comment);
  if (all.length === 0 || all.length > NARRATION_WORDS_MAX) return false;
  const rest = LEADING_VERBS.has(all[0]) ? all.slice(1) : all;
  const content = rest.filter((word) => !FILLER_WORDS.has(word));
  if (content.length === 0) return false;
  const known = new Set(words(code));
  return content.every((word) => known.has(word));
}

/** Hits are whole-line `//` comments, alone, whose every content word already appears on the next code line. */
export function narratingCommentLines(source, text) {
  const lines = text.split('\n');
  const isComment = (index) => lines[index]?.trim().startsWith('//') ?? false;
  const hits = [];
  for (const range of singleLineComments(source, text)) {
    const index = source.getLineAndCharacterOfPosition(range.pos).line;
    const line = lines[index].trim();
    if (!line.startsWith('//') || line.startsWith('///')) continue;
    if (isComment(index - 1) || isComment(index + 1)) continue;
    const code = lines[index + 1]?.trim() ?? '';
    if (code === '' || code.startsWith('/*') || code.startsWith('*')) continue;
    if (narrates(line.slice(2), code)) hits.push(index + 1);
  }
  return hits;
}
