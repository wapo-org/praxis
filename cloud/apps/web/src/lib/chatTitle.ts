/** The title length the API and iOS cap at (ConversationTitle.make). They cut without an ellipsis. */
const SERVER_TITLE_CAP = 42;

/** A title at the cap was cut mid-sentence: end it at the last word, and say so. */
export function displayTitle(title: string): string {
  if (title.length < SERVER_TITLE_CAP) return title;
  const space = title.lastIndexOf(' ');
  return `${(space >= SERVER_TITLE_CAP / 2 ? title.slice(0, space) : title).trimEnd()}…`;
}
