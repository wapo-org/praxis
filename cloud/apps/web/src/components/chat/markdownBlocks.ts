export interface ParsedBlock {
  type: 'heading' | 'code' | 'table' | 'blockquote' | 'list' | 'hr' | 'paragraph';
  level?: number;
  lang?: string;
  content?: string;
  headers?: string[];
  rows?: string[][];
  ordered?: boolean;
  items?: Array<{ checked?: boolean; text: string }>;
}

export function parseMarkdownBlocks(markdown: string): ParsedBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^```(\S*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || 'text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length && lines[i]!.startsWith('```')) {
        i++;
      }
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1]!.length,
        content: headingMatch[2]!.trim(),
      });
      i++;
      continue;
    }

    // GFM Table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1]!)
    ) {
      const parseRow = (rowStr: string) =>
        rowStr
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());

      const headers = parseRow(line);
      i += 2; // skip header and separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(parseRow(lines[i]!));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Blockquote
    if (line.trim().startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
      continue;
    }

    // Unordered or task list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Array<{ checked?: boolean; text: string }> = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        const raw = lines[i]!.replace(/^\s*[-*+]\s+/, '');
        const taskMatch = raw.match(/^\[([ xX])\]\s+(.+)$/);
        if (taskMatch) {
          items.push({
            checked: taskMatch[1]!.toLowerCase() === 'x',
            text: taskMatch[2]!,
          });
        } else {
          items.push({ text: raw });
        }
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: Array<{ checked?: boolean; text: string }> = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        const raw = lines[i]!.replace(/^\s*\d+\.\s+/, '');
        items.push({ text: raw });
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.startsWith('```') &&
      !/^(#{1,4})\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith('>')
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push({ type: 'paragraph', content: paraLines.join('\n') });
  }

  return blocks;
}
