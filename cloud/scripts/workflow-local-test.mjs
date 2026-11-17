import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes} from 'node:crypto';
import {tsImport} from 'tsx/esm/api';

const exec = promisify(execFile);
const CLI_PATH = 'node_modules/convex/bin/main.js';
const WAIT_MAX_MS = 30_000;
const POLL_MS = 250;
const LOCAL_SITE_URL = 'http://127.0.0.1:3211';
const LOCAL_AUTH_VALUE = 'local-test-only';
const PURGE_CALLS_MAX = 20;
const SESSION_TTL = {accessTokenTtlSeconds: 3600, refreshInactivityTimeoutSeconds: 7200, sessionMaxLifetimeSeconds: 7200};
const LOCAL_DEPLOYMENT = process.env.PRAXIS_LOCAL_DEPLOYMENT_NAME ?? 'anonymous-cloud';
assert.match(LOCAL_DEPLOYMENT, /^anonymous-[a-z0-9_-]+$/);
// An anonymous selector prevents inherited credentials from selecting a hosted deployment.
const env = {...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DEPLOYMENT: `anonymous:${LOCAL_DEPLOYMENT}`, CONVEX_DEPLOY_KEY: '',
  CONVEX_SELF_HOSTED_URL: '', CONVEX_SELF_HOSTED_ADMIN_KEY: ''};
async function cli(...args) {
  return (await exec(process.execPath, [CLI_PATH, ...args], {env})).stdout.trim();
}
async function run(name, args, identity, component) {
  const out = await cli('run', name, JSON.stringify(args), ...(identity ? ['--identity', JSON.stringify(identity)] : []),
    ...(component ? ['--component', component] : []));
  return out ? JSON.parse(out) : null;
}
async function data(table, component) {
  return JSON.parse(await cli('data', table, '--format', 'json', '--limit', '1000', ...(component ? ['--component', component] : [])));
}
const directory = await mkdtemp(join(tmpdir(), 'pra29-'));
try {
  const {AUTH_ENV} = await tsImport('../convex/authConstants.ts', import.meta.url);
  const envPath = join(directory, 'auth.env');
  // A fresh throwaway server token lets this run drive account deletion on the local backend only.
  const serverToken = randomBytes(32).toString('hex');
  await writeFile(envPath, [...Object.values(AUTH_ENV)
    .map(key => `${key}=${key === AUTH_ENV.siteUrl ? LOCAL_SITE_URL : LOCAL_AUTH_VALUE}`),
  `PRAXIS_CONVEX_SERVER_TOKEN=${serverToken}`].join('\n'));
  await cli('env', 'set', '--force', '--from-file', envPath);
  const usersPath = join(directory, 'users.json');
  await writeFile(usersPath, JSON.stringify([{}]));
  await cli('import', '--table', 'users', '--append', usersPath);
  const userId = (await data('users')).sort((a, b) => b._creationTime - a._creationTime)[0]._id;
  const chatId = `workflow-local-${Date.now()}`;
  const tokens = await run('public:_internal_dangerous_signIn', {claims: {method: 'test', profile: {}},
    componentPath: 'auth', userId, ...SESSION_TTL}, undefined, 'auth');
  // Auth v2 access tokens name the session as subject; getAuthUserId resolves it to the user.
  const identity = {subject: JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString()).sub};
  const path = join(directory, 'records.json');
  await writeFile(path, JSON.stringify([{userId, kind: 'chat', id: chatId, value: {}, revision: 1,
    updatedAt: new Date().toISOString(), deleted: false}]));
  await cli('import', '--table', 'records', '--append', path);
  const runId = await run('runs:start', {chatId}, identity);
  const deadline = Date.now() + WAIT_MAX_MS;
  let completed;
  while (Date.now() < deadline) {
    completed = (await data('runs')).find(row => row._id === runId);
    if (completed?.status === 'completed') break;
    assert.equal(completed?.status, 'running');
    await delay(POLL_MS);
  }
  assert.equal(completed?.status, 'completed');
  assert.equal(completed.nextTurnIndex, 3);
  const scope = {userId, chatId, runId, generation: 0, expectedTurnIndex: 0};
  const redeliveries = await Promise.all([run('turns:run', scope), run('turns:run', scope)]);
  assert.deepEqual(redeliveries[0], redeliveries[1]);
  assert.equal(redeliveries[0].turnIndex, 0);
  assert.equal((await data('turnFlags')).filter(row => row.runId === runId).length, 3);
  const steps = (await data('steps', 'workflow')).filter(row => row.workflowId === completed.workflowId);
  assert.equal(steps.filter(row => row.step.functionType === 'action').length, 3);
  await run('account:begin', {serverToken, userId});
  await assert.rejects(run('turns:run', {...scope, expectedTurnIndex: 3}));
  let purge = {done: false};
  for (let call = 0; !purge.done && call < PURGE_CALLS_MAX; call++) {
    purge = await run('account:purge', {serverToken, userId, blobCursor: purge.blobCursor, blobsDone: purge.blobsDone});
  }
  assert.equal(purge.done, true);
  assert.equal((await data('runs')).filter(row => row.userId === userId).length, 0);
  assert.equal((await data('turnFlags')).filter(row => row.runId === runId).length, 0);
  assert.equal((await data('users')).filter(row => row._id === userId).length, 0);
  assert.equal((await data('workflows', 'workflow')).filter(row => row._id === completed.workflowId).length, 0);
  assert.equal((await data('steps', 'workflow')).filter(row => row.workflowId === completed.workflowId).length, 0);
  console.log('Local Convex: three actions, completed, two concurrent redeliveries, three ledger rows, '
    + 'deletion fenced and purged run, flags, journal and user; PASS');
} finally {
  await rm(directory, {recursive: true, force: true});
}
