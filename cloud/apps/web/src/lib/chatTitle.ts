/** Matches server/iOS title cap without ellipsis. */
const SERVER_TITLE_CAP = 42;

/** Trim mid-word server truncation at the last word boundary. */
export function displayTitle(title: string): string {
  if (title.length < SERVER_TITLE_CAP) return title;
  const space = title.lastIndexOf(' ');
  return `${(space >= SERVER_TITLE_CAP / 2 ? title.slice(0, space) : title).trimEnd()}…`;
}
