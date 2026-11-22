import {it, expect} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

it('checks authored comments while excluding regenerated Convex utilities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'comment-sweep-'));
  try {
    mkdirSync(join(directory, '_generated'));
    const comment = '/**\n * First line.\n * Second line.\n */\nexport const value = 1;\n';
    writeFileSync(join(directory, '_generated', 'api.ts'), comment);
    writeFileSync(join(directory, 'authored.ts'), comment);
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL('./comment-sweep.mjs', import.meta.url)), 'check', '--scope', directory], {encoding: 'utf8'});
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('authored.ts');
    expect(result.stdout).not.toContain('_generated/api.ts');
    expect(result.stdout).toContain('Violations (>1L or >130c): 1');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
