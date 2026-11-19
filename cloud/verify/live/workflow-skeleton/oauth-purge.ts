import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {z} from 'zod';
import type {SealedSecret} from '@praxis/types';
import {check, errorText, stepResult, type Check, type StepResult} from '../convex-typed-rows/checks.js';
import {convexCliReader, purgeUntilDone, serverTokenFromDeployment, type Live} from '../convex-typed-rows/commit-purge.js';
import {createLiveOwners, newRunId, type LiveOwner} from '../convex-typed-rows/owners.js';

export const OAUTH_PURGE_ID = 'oauth-emails-purge';
export const OAUTH_PURGE_CHECKLIST = '`oauthEmails` rows for an OAuth user are purged';
const OAUTH_TABLE = 'oauthEmails';
/** `.invalid` is reserved (RFC 2606), so the seeded address can never belong to a real Google account. */
const SEED_EMAIL_DOMAIN = 'oauth.invalid';
const RECENT_SIGNUP_ROWS_MAX = 50;
const CLI_OUTPUT_BYTES_MAX = 16 * 1024 * 1024;
const SEEDED_NOTE = 'row seeded with the deploy key via `convex import`, not written by a real Google sign-in (PRA-111/PRA-126)';

const run = promisify(execFile);
const Begin = makeFunctionReference<'mutation'>('account:begin');
const Active = makeFunctionReference<'query'>('account:active');
const OAuthEmailRow = z.object({userId: z.string(), email: z.string()});

export type OAuthPurgeEnv = {
  convexUrl: string;
  deployKey: SealedSecret;
  /** `cloud/`, where `npx convex` finds the project config. */
  cwd: string;
  log?: (line: string) => void;
};

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

async function importRow(env: OAuthPurgeEnv, row: {userId: string; email: string}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pra125-oauth-'));
  try {
    const file = join(dir, `${OAUTH_TABLE}.jsonl`);
    await writeFile(file, `${JSON.stringify(row)}\n`);
    const args = ['--no-install', 'convex', 'import', '--table', OAUTH_TABLE, '--append', '--format', 'jsonLines', '-y', file];
    await run('npx', args, {
      cwd: env.cwd, env: {...process.env, CONVEX_DEPLOY_KEY: env.deployKey.reveal()}, maxBuffer: CLI_OUTPUT_BYTES_MAX,
    }).catch(() => {
      throw new Error(`npx convex import into ${OAUTH_TABLE} failed`);
    });
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

async function erase(live: Live, userId: string): Promise<boolean> {
  const client = new ConvexHttpClient(live.convexUrl, {logger: false});
  const scope = {serverToken: live.serverToken.reveal(), userId};
  if (z.boolean().parse(await client.query(Active, scope))) await client.mutation(Begin, scope);
  return (await purgeUntilDone(live, {userId})).status === 'pass';
}

async function seedAndPurge(env: OAuthPurgeEnv, live: Live, owner: LiveOwner, runId: string): Promise<Check[]> {
  const reader = convexCliReader(env.deployKey, env.cwd);
  const row = oauthEmailRow(owner.userId, seedOAuthEmail(runId));
  await importRow(env, row);
  const before = oauthRowsFor(await reader(OAUTH_TABLE), owner.userId, row.email);
  env.log?.(`seeded ${OAUTH_TABLE} for ${owner.userId}; rows before purge ${before}`);
  const purged = await erase(live, owner.userId);
  const after = oauthRowsFor(await reader(OAUTH_TABLE), owner.userId, row.email);
  return [
    check('seeded row visible', before === 1, `${before} ${OAUTH_TABLE} row(s) for the owner; ${SEEDED_NOTE}`),
    check('account:purge done', purged, purged ? 'account:begin then account:purge reported done' : 'purge did not finish'),
    check('no oauthEmails left', after === 0, `${after} ${OAUTH_TABLE} row(s) for the owner or seeded email after purge`),
  ];
}

/** Checklist 6: one password owner plus a seeded OAuth email row, erased by the server purge. */
export async function verifyOAuthEmailPurge(env: OAuthPurgeEnv): Promise<StepResult> {
  const live: Live = {convexUrl: env.convexUrl, serverToken: await serverTokenFromDeployment(env.deployKey, env.cwd)};
  const runId = newRunId();
  let ownerId: string | undefined;
  let checks: Check[];
  try {
    const [owner] = await createLiveOwners(live.convexUrl, 1, {
      deployKey: env.deployKey, reader: convexCliReader(env.deployKey, env.cwd, RECENT_SIGNUP_ROWS_MAX),
      runId, log: env.log, onOwner: userId => { ownerId = userId; },
    });
    if (!owner) throw new Error('sign-up returned no owner');
    checks = await seedAndPurge(env, live, owner, runId);
  } catch (error) {
    checks = [check('step ran', false, errorText(error))];
    // A half-run must not leave the disposable owner or its seeded row on the deployment.
    if (ownerId) await erase(live, ownerId).catch(() => false);
  }
  const result = stepResult(OAUTH_PURGE_ID, OAUTH_PURGE_CHECKLIST, checks);
  return {...result, summary: `${result.summary}; ${SEEDED_NOTE}`};
}
