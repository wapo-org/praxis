import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { root } from './deploy-config.mjs';
/** The only cloud/ paths the API deployment needs (npm ci runs in cloud/ and builds apps/api). */
export const API_SOURCES = [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'apps/api',
  'apps/web/package.json',
  'packages',
];
const SKIP =
  /(^|\/)(node_modules|dist|coverage|tests|testing|\.vercel|\.deploy|\.convex)(\/|$)|\.test\.tsx?$|(^|\/)\.DS_Store$|(^|\/)\.env(?!\.example$)[^/]*$/;
/** Secret-bearing or out-of-scope paths that must never be uploaded. */
const FORBIDDEN =
  /(^|\/)\.env(?!\.example$)[^/]*$|(^|\/)(PraxisChat|\.deploy|\.git)(\/|$)|\.(pem|key|p8|p12|mobileprovision)$|(^|\/)deploy\.env$/;
export const VERCELIGNORE = [
  '.env*',
  '**/.env*',
  '!**/.env.example',
  'PraxisChat',
  '.deploy',
  '*.pem',
  '*.key',
  '*.p8',
  '*.p12',
  '',
].join('\n');
export async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, {
    withFileTypes: true,
    recursive: true,
  }))
    if (entry.isFile())
      out.push(relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
  return out.sort();
}
/** Fails on forbidden paths, and on any file that contains a configured secret value. */
export async function assertSafeUpload(dir, files, secrets = []) {
  const bad = files.filter((f) => FORBIDDEN.test(f));
  if (bad.length) throw Error(`Upload contains forbidden files: ${bad.join(', ')}`);
  const values = secrets.filter((v) => typeof v === 'string' && v.length >= 16);
  if (values.length)
    for (const f of files) {
      const text = await readFile(join(dir, f), 'latin1');
      if (values.some((v) => text.includes(v)))
        throw Error(`Upload file ${f} contains a deployment secret`);
    }
}
/** Mirrors the repo layout (cloud/apps/api is the project's root directory) from an allowlist only. */
export async function stageApi(stage = join(root, '.deploy/api'), from = root) {
  await rm(stage, { recursive: true, force: true });
  for (const source of API_SOURCES)
    await cp(join(from, source), join(stage, 'cloud', source), {
      recursive: true,
      filter: (path) => !SKIP.test(relative(from, path).split(sep).join('/')),
    });
  await writeFile(join(stage, '.vercelignore'), VERCELIGNORE);
  return stage;
}
/** A private 0600 file in a 0700 directory, removed afterwards, also on SIGINT/SIGTERM. */
export async function withPrivateFile(value, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-deploy-'));
  const cleanup = (signal) => {
    rmSync(dir, { recursive: true, force: true });
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  try {
    const file = join(dir, 'input');
    await writeFile(file, value, { mode: 0o600 });
    return await fn(file);
  } finally {
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    await rm(dir, { recursive: true, force: true });
  }
}
export async function writeUploadList(stage, files) {
  await mkdir(join(stage, '..'), { recursive: true });
  const list = join(stage, '..', `${stage.split(sep).at(-1)}-upload.txt`);
  await writeFile(list, files.join('\n') + '\n');
  return list;
}
