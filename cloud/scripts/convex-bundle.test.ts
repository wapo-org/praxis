import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {bundleConvex} from './convex-bundle.mjs';

const dirs: string[] = [];
async function convexDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'convex-bundle-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});

const NODE_IMPORT = "import {createHash} from 'node:crypto';\nexport const hash = (text: string) => createHash('sha256').update(text).digest('hex');\n";

it('fails on a Node built-in reached from a default-runtime module, as convex deploy does', async () => {
  const dir = await convexDir({'helper.ts': NODE_IMPORT, 'turns.ts': "import {hash} from './helper.js';\nexport const run = () => hash('x');\n"});
  await expect(bundleConvex(dir)).rejects.toThrow(/node:crypto/);
});

it('bundles the same import inside a "use node" module, and skips _generated, schema and dotted config files', async () => {
  const dir = await convexDir({'node.ts': `"use node";\n${NODE_IMPORT}`, 'auth.config.ts': NODE_IMPORT,
    'plain.ts': 'export const ok = () => 1;\n'});
  expect(await bundleConvex(dir)).toMatchObject({isolate: {entries: 1}, node: {entries: 1}});
});

it('bundles the real cloud/convex directory for both runtimes', async () => {
  const result = await bundleConvex();
  expect(result.isolate.entries).toBeGreaterThan(40);
}, 120_000);
