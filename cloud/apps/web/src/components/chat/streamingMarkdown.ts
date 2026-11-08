/** Withhold incomplete structural syntax; completed blocks retain their identity. */
export function stableStreamingMarkdown(text: string): string {
  let cut = text.length;
  const fences = [...text.matchAll(/^```.*$/gm)];
  if (fences.length % 2) cut = Math.min(cut, fences.at(-1)!.index!);
  // A pipe-prefixed header is ambiguous until its separator has arrived.
  const rows = [...text.matchAll(/^\|.*$/gm)];
  for (const row of rows) {
    const end = row.index! + row[0].length;
    if (end === text.length) { cut = Math.min(cut, row.index!); break; }
    const next = text.slice(end + 1).split('\n')[0] ?? '';
    if (!/^\|?[\s:|-]+\|/.test(next) && row.index === rows[0]?.index) cut = Math.min(cut, row.index!);
  }
  const candidate = text.slice(0, cut);
  for (const marker of ['**', '`', '$$']) {
    const positions = [...candidate.matchAll(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'g'))];
    if (positions.length % 2) cut = Math.min(cut, positions.at(-1)!.index!);
  }
  const link = candidate.lastIndexOf('[');
  if (link >= 0 && !candidate.slice(link).includes(')')) cut = Math.min(cut, link);
  return text.slice(0, cut);
}
