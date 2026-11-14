import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
const root = new URL('../dist/assets/', import.meta.url);
const names = (await readdir(root)).filter(name => name.endsWith('.js'));
assert.ok(names.length, 'Build the web app before checking its bundle');
const chunks = await Promise.all(names.map(name => readFile(new URL(name, root))));
const text = chunks.map(chunk => chunk.toString()).join('\n');
for (const marker of ['devAuth', '/v1/auth/dev', 'Liquid Glass Optical Lab', 'apple-notes-menu-trigger', 'Synthetic Model']) {
  assert.equal(text.includes(marker), false, `Production bundle contains ${marker}`);
}
console.log(`PASS: lab/dev-auth absent; ${chunks.reduce((n, chunk) => n + chunk.length, 0)} JS bytes, ${chunks.reduce((n, chunk) => n + gzipSync(chunk).length, 0)} gzip bytes`);
const entryIndex = names.findIndex(name => /^index-/.test(name));
assert.ok(entryIndex >= 0, 'Expected a Vite entry chunk');
assert.ok(chunks[entryIndex].length <= 450_000, `Entry JS exceeds 450 kB: ${chunks[entryIndex].length}`);
console.log(`PASS: initial entry ${chunks[entryIndex].length} raw bytes (limit 450000); authenticated and routed chunks reported separately above`);
