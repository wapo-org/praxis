import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {AUTH_PATHS} from '@praxis/protocol';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VercelConfigSchema = z.object({
  rewrites: z.array(z.object({source: z.string(), destination: z.string()})),
});

describe('Vercel SPA fallback', () => {
  // Emailed auth links open deep paths directly; without the fallback Vercel answers 404 before the router loads.
  it('rewrites every client route, including each emailed auth path, to index.html', () => {
    const config = VercelConfigSchema.parse(JSON.parse(readFileSync(resolve(WEB_ROOT, 'vercel.json'), 'utf8')));
    const fallback = config.rewrites.find(rewrite => rewrite.destination === '/index.html');
    expect(fallback?.source).toBe('/(.*)');
    const matches = new RegExp(`^${fallback?.source ?? ''}$`);
    for (const path of [...Object.values(AUTH_PATHS), '/c/chat-id']) expect(matches.test(path)).toBe(true);
  });
});
