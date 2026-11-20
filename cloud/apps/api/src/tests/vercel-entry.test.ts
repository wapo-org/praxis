import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VercelConfigSchema = z.object({functions: z.record(z.string(), z.unknown())});
const PackageSchema = z.object({scripts: z.object({build: z.string()})});

function read(path: string): string {
  return readFileSync(join(API_ROOT, path), 'utf8');
}

describe('Vercel function entry', () => {
  it('serves the esbuild bundle, never a TypeScript file Vercel would transpile without bundling', () => {
    const functions = Object.keys(VercelConfigSchema.parse(JSON.parse(read('vercel.json'))).functions);
    expect(functions).toEqual(['api/index.mjs']);
    for (const entry of functions) expect(existsSync(join(API_ROOT, entry))).toBe(true);

    const outfile = /--outfile=(\S+)/.exec(PackageSchema.parse(JSON.parse(read('package.json'))).scripts.build)?.[1];
    expect(outfile).toBe('dist/index.mjs');
    expect(read('api/index.mjs')).toContain(`from '../${outfile}'`);
  });

  it('re-exports every HTTP method the bundle entry exports', () => {
    const exported = (source: string) => [...source.matchAll(/export const (\w+) = handler/g)].map(match => match[1]);
    const methods = exported(read('src/vercel.ts'));
    expect(methods.length).toBeGreaterThan(0);
    const shim = /export \{([^}]+)\} from/.exec(read('api/index.mjs'))?.[1].split(',').map(name => name.trim());
    expect(shim).toEqual(['default', ...methods]);
  });
});
