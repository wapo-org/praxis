/** The title length the API and iOS cap at (ConversationTitle.make). They cut without an ellipsis. */
const SERVER_TITLE_CAP = 42;

/** Collapse any line breaks or repeated whitespace so a chat title always stays single-line in UI chrome. */
export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/** A title at the cap was cut mid-sentence: end it at the last word, and say so. */
export function displayTitle(title: string): string {
  const normalized = normalizeTitle(title);
  if (normalized.length < SERVER_TITLE_CAP) return normalized;
  const space = normalized.lastIndexOf(' ');
  return `${(space >= SERVER_TITLE_CAP / 2 ? normalized.slice(0, space) : normalized).trimEnd()}…`;
}
