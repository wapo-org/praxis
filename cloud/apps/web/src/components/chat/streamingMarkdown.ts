/** Withhold incomplete structural syntax; completed blocks retain their identity. */
export function stableStreamingMarkdown(text: string): string {
  let cut = text.length;
  const lineStart = text.lastIndexOf('\n') + 1;
  if (/^\s*(?:#{1,4}|[-+*]|\d+\.)\s*$/.test(text.slice(lineStart))) cut = lineStart;
  const trailing = /[*~_`]+$/.exec(text);
  if (trailing) cut = Math.min(cut, trailing.index);
  const fences = [...text.slice(0, cut).matchAll(/^```.*$/gm)];
  if (fences.length % 2) cut = Math.min(cut, fences.at(-1)!.index!);
  // Code is opaque to inline syntax and table detection. Preserve offsets in the original source.
  const masked = text.slice(0, cut).replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*(?:\n|$)/gm, code => code.replace(/[^\n]/g, ' '));
  const rows = [...masked.matchAll(/^\|.*$/gm)];
  for (const row of rows) {
    const end = row.index! + row[0].length;
    if (end === masked.length) { cut = Math.min(cut, row.index!); break; }
    const next = masked.slice(end + 1).split('\n')[0] ?? '';
    if (!/^\|?[\s:|-]+\|/.test(next) && row.index === rows[0]?.index) cut = Math.min(cut, row.index!);
  }
  const candidate = masked.slice(0, cut);
  for (const marker of ['**', '`', '$$', '~~', '*', '$']) {
    const positions = [...candidate.matchAll(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'g'))];
    // An asterisk at the start of a list is structural rather than an inline delimiter.
    const inline = marker === '*' ? positions.filter(p => !/^[ \t]*$/.test(candidate.slice(candidate.lastIndexOf('\n',p.index!-1)+1,p.index)) || !/\s/.test(candidate[p.index!+1] ?? '')) : positions;
    if (inline.length % 2) cut = Math.min(cut, inline.at(-1)!.index!);
  }
  const link = candidate.lastIndexOf('[');
  if (link >= 0 && !candidate.slice(link).includes(')')) cut = Math.min(cut, link);
  return text.slice(0, cut);
}
