import { readFile, access } from 'node:fs/promises';
const report = new URL('../../../docs/web/PARITY.md', import.meta.url);
const markdown = await readFile(report, 'utf8');
let count = 0;
for (const [, link] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
  if (/^(https?:|#)/.test(link)) continue;
  await access(new URL(link.split('#')[0], report)); count++;
}
console.log(`PASS: ${count} parity links resolve`);
