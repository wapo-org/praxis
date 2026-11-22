import type {CatalogModel as Model} from '@praxis/protocol';

export const TITLE_MAX_CHARS = 48;
export const TITLE_MAX_WORDS = 6;

const EXCLUDED_MODEL_RE =
  /:free(?:$|:)|^openrouter\/(?:free|auto)$|(?:^|[/-])(?:o[134](?:-|$)|.*reasoning|.*thinking|deepseek-r1|.*(?:embed|embedding|moderation|guard|safeguard|whisper|tts|audio|realtime|dall-e|imagen|flux|sora))/i;

const WEAK_MODEL_RE = /\b(?:0\.5b|1b|1\.5b|2b|3b|4b|7b|8b)\b|nemotron-nano/i;
const FRONTIER_COMPACT_RE =
  /(?:gpt-4\.1-(?:mini|nano)|gpt-4o-mini|gpt-5(?:\.\d+)?-(?:mini|nano)|claude-(?:[\d.-]+-)?haiku|gemini-(?:2(?:\.\d+)?|3(?:\.\d+)?)-flash(?!-lite))/i;
const STRONG_INSTRUCT_RE =
  /(?:gpt-4\.1|gpt-4o|gpt-5|claude-[\d.-]*sonnet|gemini-(?:2(?:\.\d+)?|3(?:\.\d+)?)-(?:flash-lite|pro)|qwen[\d.-]*-(?:32b|72b|235b)|llama-3\.[13]-70b)/i;
const GENERIC_COMPACT_RE = /\b(?:nano|mini|flash(?:-lite)?|haiku|small)\b/i;

const GREETING_RE =
  /^(?:hi|hello|hey|yo|sup|hiya|howdy|greetings|good\s+(?:morning|afternoon|evening)|hola|bonjour|salut)[\s!.,?~]*$/i;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'about', 'all', 'also', 'am', 'are', 'as', 'assistant', 'at',
  'be', 'before', 'between', 'but', 'by', 'can', 'chat', 'conversation', 'could',
  'did', 'do', 'does', 'even', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here',
  'hers', 'him', 'his', 'how', 'in', 'into', 'is', 'it', 'its', 'just', 'may', 'me',
  'message', 'might', 'more', 'most', 'must', 'my', 'not', 'of', 'on', 'options', 'or',
  'our', 'over', 'please', 'question', 'reply', 'request', 'response', 'she', 'should',
  'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'title', 'to', 'topic', 'us', 'user', 'very',
  'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
]);

export function instructionTier(m: Model): number {
  if (WEAK_MODEL_RE.test(m.id)) return 0;
  if (FRONTIER_COMPACT_RE.test(m.id)) return 4;
  if (STRONG_INSTRUCT_RE.test(m.id)) return 3;
  if (GENERIC_COMPACT_RE.test(m.id)) return 2;
  return 1;
}

/** Paid text models without a mandatory reasoning budget, ranked by instruction-following then price/speed. */
export function titleModels(models: Model[]): Model[] {
  const cost = (m: Model) => (m.pricing ? 200 * Number(m.pricing.prompt) + 32 * Number(m.pricing.completion) : Infinity);
  const cmpCost = (a: Model, b: Model) => {
    const ca = cost(a);
    const cb = cost(b);
    return ca === cb ? 0 : ca - cb;
  };
  return models
    .filter(
      (m) =>
        !EXCLUDED_MODEL_RE.test(m.id) && !m.reasoningMandatory &&
        (!m.pricing || (Number(m.pricing.prompt) > 0 && Number(m.pricing.completion) > 0)),
    )
    .sort(
      (a, b) =>
        instructionTier(b) - instructionTier(a) ||
        cmpCost(a, b) ||
        a.id.localeCompare(b.id),
    );
}

export const titleModel = (models: Model[]) => titleModels(models)[0];

function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  return w
    .replace(/ies$/, 'y')
    .replace(/(?:sses|shes|ches|xes|zes)$/, (m) => m.slice(0, -2))
    .replace(/(?:ation|tion|ition|ing|ied|ies|ed|es|er|ly|ment|s)$/, '')
    .replace(/e$/, '');
}

function extractTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

function contentTokens(text: string): string[] {
  const all = extractTokens(text);
  const filtered = all.filter((t) => !STOPWORDS.has(t));
  return filtered.length > 0 ? filtered : all;
}

function sharesContentWord(title: string, userMessage: string): boolean {
  if (GREETING_RE.test(userMessage.trim())) return true;
  const msgTokens = contentTokens(userMessage);
  if (msgTokens.length === 0) return true;
  const titleTokens = contentTokens(title);
  if (titleTokens.length === 0) return false;
  const msgSet = new Set(msgTokens);
  const msgStems = new Set(msgTokens.map(stem).filter((s) => s.length >= 3));
  for (const tok of titleTokens) {
    if (msgSet.has(tok)) return true;
    const st = stem(tok);
    if (st.length >= 3 && msgStems.has(st)) return true;
  }
  return false;
}

function stripOuterQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['\u201c', '\u201d'],
    ['\u2018', '\u2019'],
  ];
  let current = value.trim();
  for (const [open, close] of pairs) {
    if (current.length >= 2 && current.startsWith(open) && current.endsWith(close)) {
      current = current.slice(1, -1).trim();
      break;
    }
  }
  return current;
}

/** Validates a candidate chat title before storing; rejects conversational, multiline, markdown, or ungrounded output. */
export function validateTitle(raw: string, userMessage: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;

  const candidate = stripOuterQuotes(trimmed);
  if (!candidate || /[\r\n]/.test(candidate)) return null;

  // Reject list items, markdown formatting, headings, code fences, links, or meta prefixes.
  if (
    /^(?:[-*+\u2022\u2023\u25e6]|\d+[.)])\s/.test(candidate) ||
    /^(?:#{1,6}\s|>|```|~~~|---|___|\*\*\*|\|)/.test(candidate) ||
    /`|\*\*|__|~~|\[[^\]]+\]\([^)]+\)/.test(candidate) ||
    /(?:^|\s)[*_]\S|\S[*_](?:\s|$)/.test(candidate) ||
    /^(?:title|chat title|subject|label|topic|chat)\s*:/i.test(candidate)
  ) {
    return null;
  }

  // Reject conversational openers ("Here...", "Sure...", "Certainly...", "Of course...", "I ..." / "I'm...").
  if (/^(?:here(?:\s|['’]s\b|:)|sure(?:\b|[,!.:])|of\s+course(?:\b|[,!.:])|certainly(?:\b|[,!.:])|i(?:\s|['’](?:m|ll|d|ve)\b))/i.test(candidate)) {
    return null;
  }

  // Reject trailing conversational question/exclamation marks.
  if (/[?!]$/.test(candidate)) {
    return null;
  }

  const whitespaceWords = candidate.split(/\s+/).filter(Boolean);
  const lexicalWords = candidate.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  if (lexicalWords.length === 0 || whitespaceWords.length > TITLE_MAX_WORDS || candidate.length > TITLE_MAX_CHARS) {
    return null;
  }

  if (!sharesContentWord(candidate, userMessage)) {
    return null;
  }

  return candidate;
}
