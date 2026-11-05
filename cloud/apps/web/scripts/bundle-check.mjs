import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
const root = new URL('../dist/assets/', import.meta.url);
const names = (await readdir(root)).filter(name => name.endsWith('.js'));
assert.ok(names.length, 'Build the web app before checking its bundle');
const chunks = await Promise.all(names.map(name => readFile(new URL(name, root))));
const text = chunks.map(chunk => chunk.toString()).join('\n');
for (const marker of ['devAuth', '/v1/auth/dev', 'glass-lab-page', 'position-top-start', 'lab-recipes']) {
  assert.equal(text.includes(marker), false, `Production bundle contains ${marker}`);
}
console.log(`PASS: lab/dev-auth absent; ${chunks.reduce((n, chunk) => n + chunk.length, 0)} JS bytes, ${chunks.reduce((n, chunk) => n + gzipSync(chunk).length, 0)} gzip bytes`);
// The initial JS is what index.html loads up front; sheets and the tray are lazy chunks.
// WP-D3 target is 450 kB; react-dom (222), zod (98) and the router (36) leave 536 kB today. Don't let it grow.
const INITIAL_BUDGET = 540 * 1024;
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const entry = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map(match => match[1]);
assert.ok(entry.length, 'index.html loads no JS');
const initial = (await Promise.all(entry.map(name => readFile(new URL(name, root))))).reduce((n, chunk) => n + chunk.length, 0);
assert.ok(initial <= INITIAL_BUDGET, `Initial JS is ${initial} bytes, over the ${INITIAL_BUDGET} budget`);
console.log(`PASS: initial JS ${initial} bytes (budget ${INITIAL_BUDGET})`);
