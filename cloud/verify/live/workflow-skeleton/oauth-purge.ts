import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {z} from 'zod';
import type {StepContext} from '@praxis/verify';
import {check, stepResult} from '../convex-typed-rows/checks.js';
import {purgeUntilDone} from '../convex-typed-rows/commit-purge.js';
import {hostedFixture} from '../convex-typed-rows/fixture.js';

export const SEEDED_OAUTH_PURGE_ID = 'seeded-oauth-emails-purge';
export const OAUTH_PURGE_CHECKLIST = '`oauthEmails` rows for an OAuth user are purged.';
const OAUTH_TABLE = 'oauthEmails';
/** `.invalid` is reserved (RFC 2606), so the seeded address can never belong to a real Google account. */
const SEED_EMAIL_DOMAIN = 'oauth.invalid';
const CLOUD_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const CLI_OUTPUT_BYTES_MAX = 16 * 1024 * 1024;
const SEEDED_NOTE = 'row seeded with `convex import` on a disposable password owner (PRA-111/PRA-126 cover provider sign-in)';

const run = promisify(execFile);
const Begin = makeFunctionReference<'mutation'>('account:begin');
const OAuthEmailRow = z.object({userId: z.string(), email: z.string()});

/** Same normalisation `createOAuthUser` applies (`cloud/convex/users.ts`) before it inserts the row. */
export function oauthEmailRow(userId: string, email: string): {userId: string; email: string} {
  return {userId, email: email.toLowerCase().normalize('NFC')};
}

export function seedOAuthEmail(runId: string): string {
  if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('run id must be a lowercase token');
  return `Live-PRA125-${runId}@${SEED_EMAIL_DOMAIN}`;
}

/** Rows that match the owner or the seeded address; unparseable rows count, so drift cannot hide a leftover. */
export function oauthRowsFor(rows: readonly unknown[], userId: string, email: string): number {
  return rows.filter(row => {
    const parsed = OAuthEmailRow.safeParse(row);
    return !parsed.success || parsed.data.userId === userId || parsed.data.email === email;
  }).length;
}

async function importRow(context: StepContext, row: {userId: string; email: string}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pra125-oauth-'));
  try {
    const file = join(dir, `${OAUTH_TABLE}.jsonl`);
    await writeFile(file, `${JSON.stringify(row)}\n`);
    const args = ['--no-install', 'convex', 'import', '--table', OAUTH_TABLE, '--append', '--format', 'jsonLines', '-y', file];
    await run('npx', args, {
      cwd: CLOUD_DIR, env: {...process.env, CONVEX_DEPLOY_KEY: context.secret('CONVEX_DEPLOY_KEY').reveal()}, maxBuffer: CLI_OUTPUT_BYTES_MAX,
    }).catch(() => {
      throw new Error(`npx convex import into ${OAUTH_TABLE} failed`);
    });
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

export async function verifySeededOAuthEmailPurge(context: StepContext) {
  const {live, owners: [, owner], reader, runId} = await hostedFixture(context);
  const row = oauthEmailRow(owner.userId, seedOAuthEmail(runId));
  await importRow(context, row);
  const before = oauthRowsFor(await reader(OAUTH_TABLE), owner.userId, row.email);
  const server = new ConvexHttpClient(live.convexUrl, {logger: false});
  const purge = await (async () => {
    await server.mutation(Begin, {serverToken: live.serverToken.reveal(), userId: owner.userId});
    return purgeUntilDone(live, owner);
  })().catch(() => {
    throw new Error('Account deletion failed for the seeded OAuth email owner');
  });
  const after = oauthRowsFor(await reader(OAUTH_TABLE), owner.userId, row.email);
  const checks = [
    check('seeded row visible', before === 1, `${before} ${OAUTH_TABLE} row(s) for the owner`),
    check('account:purge done', purge.status === 'pass', purge.summary),
    check('no oauthEmails left', after === 0, `${after} ${OAUTH_TABLE} row(s) for the owner or seeded email after purge`),
  ];
  context.attach('checks.json', JSON.stringify({fixture: SEEDED_NOTE, checks}, null, 2));
  const result = stepResult(SEEDED_OAUTH_PURGE_ID, OAUTH_PURGE_CHECKLIST, checks);
  return {status: result.status, summary: `${result.summary}. Fixture: ${SEEDED_NOTE}`};
}
