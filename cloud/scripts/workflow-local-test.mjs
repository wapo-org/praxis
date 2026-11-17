import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const exec = promisify(execFile);
const CLI_PATH = 'node_modules/convex/bin/main.js';
const WAIT_MAX_MS = 30_000;
const POLL_MS = 250;
const LOCAL_DEPLOYMENT = process.env.PRAXIS_LOCAL_DEPLOYMENT_NAME ?? 'anonymous-cloud';
assert.match(LOCAL_DEPLOYMENT, /^anonymous-[a-z0-9_-]+$/);
// An anonymous selector prevents inherited credentials from selecting a hosted deployment.
const env = {...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DEPLOYMENT: `anonymous:${LOCAL_DEPLOYMENT}`, CONVEX_DEPLOY_KEY: '',
  CONVEX_SELF_HOSTED_URL: '', CONVEX_SELF_HOSTED_ADMIN_KEY: ''};
async function cli(...args) {
  return (await exec(process.execPath, [CLI_PATH, ...args], {env})).stdout.trim();
}
async function run(name, args, identity) {
  return JSON.parse(await cli('run', name, JSON.stringify(args), ...(identity ? ['--identity', JSON.stringify(identity)] : [])));
}
async function data(table, component) {
  return JSON.parse(await cli('data', table, '--format', 'json', '--limit', '1000', ...(component ? ['--component', component] : [])));
}
const directory = await mkdtemp(join(tmpdir(), 'pra29-'));
try {
  const userId = `workflow-local-${Date.now()}`;
  const chatId = userId;
  const identity = {subject: userId, issuer: 'workflow-local-test'};
  const path = join(directory, 'records.json');
  await writeFile(path, JSON.stringify([{userId, kind: 'chat', id: chatId, value: {}, revision: 1,
    updatedAt: new Date().toISOString(), deleted: false}]));
  await cli('import', '--table', 'records', '--append', path);
  const usersPath = join(directory, 'users.json');
  await writeFile(usersPath, JSON.stringify([{model: 'user', id: userId, data: {id: userId}}]));
  await cli('import', '--table', 'authDocuments', '--append', usersPath);
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
  console.log('Local Convex: three actions, completed, two concurrent redeliveries, three ledger rows; PASS');
} finally {
  await rm(directory, {recursive: true, force: true});
}
