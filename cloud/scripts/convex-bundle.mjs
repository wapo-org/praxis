#!/usr/bin/env node
// Bundles cloud/convex with the pinned Convex CLI's esbuild settings, as `convex deploy` does, without a deployment.
import {readdirSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const CLOUD = resolve(import.meta.dirname, '..');
const CONVEX_DIR = resolve(CLOUD, 'convex');
const CONVEX_PACKAGE = resolve(CLOUD, 'node_modules/convex');
const CONVEX_BUNDLER = join(CONVEX_PACKAGE, 'dist/esm/bundler');
const ENTRY_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx'];
const USE_NODE = /^\s*("|')use node("|');?\s*$/m;

/** The same entry-point rules as `entryPoints` in the Convex CLI's bundler. */
function entryPoints(dir) {
  const out = [];
  const walk = path => {
    for (const entry of readdirSync(path, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      const rel = relative(dir, full);
      if (entry.isDirectory()) {
        if (!rel.startsWith('_generated') && !readdirSync(full).includes('convex.config.ts')) walk(full);
        continue;
      }
      const base = entry.name;
      const skipped = !ENTRY_EXTENSIONS.some(ext => base.endsWith(ext)) || base.startsWith('.') || base.startsWith('#')
        || base === 'schema.ts' || base.indexOf('.') !== base.lastIndexOf('.') || rel.includes(' ');
      if (!skipped && /^\s{0,100}(import|export)/m.test(readFileSync(full, 'utf8'))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function kilobytes(result) {
  return Math.round(result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0) / 1024);
}

/** Mirrors `innerEsbuild` in convex/dist/esm/bundler/debugBundle.js, run with the esbuild the Convex CLI resolves. */
async function convexEsbuild(entryPoints, platform, dir) {
  const esbuild = createRequire(join(CONVEX_PACKAGE, 'package.json'))('esbuild');
  const {wasmPlugin} = await import(pathToFileURL(join(CONVEX_BUNDLER, 'wasm.js')).href);
  const {serverOnlyPlugin} = await import(pathToFileURL(join(CONVEX_BUNDLER, 'serverOnly.js')).href);
  const asyncHooksShim = {
    name: 'convex-async-hooks-shim',
    setup(build) {
      if (platform !== 'browser') return;
      build.onResolve({filter: /^(node:)?async_hooks$/}, args => ({path: args.path, namespace: 'async-hooks-shim'}));
      build.onLoad({filter: /.*/, namespace: 'async-hooks-shim'}, () => ({
        contents: 'export const AsyncLocalStorage = globalThis.AsyncLocalStorage; export default {AsyncLocalStorage};', loader: 'js',
      }));
    },
  };
  return esbuild.build({
    entryPoints, bundle: true, platform, format: 'esm', target: 'esnext', jsx: 'automatic', outdir: 'out', outbase: dir,
    conditions: ['convex', 'module'], plugins: [asyncHooksShim, serverOnlyPlugin, wasmPlugin], write: false,
    splitting: true, chunkNames: join(platform === 'node' ? `_deps${sep}node` : '_deps', '[hash]'), treeShaking: true,
    minifySyntax: true, minifyIdentifiers: true, keepNames: true, define: {'process.env.NODE_ENV': '"production"'},
    metafile: true, logLevel: 'error',
  });
}

export async function bundleConvex(dir = CONVEX_DIR) {
  const entries = entryPoints(dir);
  const node = entries.filter(file => USE_NODE.test(readFileSync(file, 'utf8').split('\n').slice(0, 5).join('\n')));
  const isolate = entries.filter(file => !node.includes(file));
  const convex = await convexEsbuild(isolate, 'browser', dir);
  const nodeRuntime = node.length ? await convexEsbuild(node, 'node', dir) : {outputFiles: []};
  return {isolate: {entries: isolate.length, kilobytes: kilobytes(convex)}, node: {entries: node.length, kilobytes: kilobytes(nodeRuntime)}};
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await bundleConvex();
    console.log(`convex bundle: ok (default runtime ${result.isolate.entries} modules, ${result.isolate.kilobytes} KB;`
      + ` node ${result.node.entries} modules, ${result.node.kilobytes} KB)`);
  } catch (error) {
    console.error('convex bundle: failed. A default-runtime module imports a Node API; move it to a "use node" file or use Web APIs.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
