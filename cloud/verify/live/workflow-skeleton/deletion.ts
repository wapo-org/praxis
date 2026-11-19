import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import type {StepContext} from '@praxis/verify';
import {z} from 'zod';
import {STUB_TURNS_MAX, WORKFLOW_ERRORS} from '../../../convex/workflows/constants.js';
import {typedApi} from '../convex-typed-rows/api.js';
import {AUTH_REQUIRED, errorText, settle} from '../convex-typed-rows/checks.js';
import {purgeUntilDone, snapshotJournal} from '../convex-typed-rows/commit-purge.js';
import {hostedFixture} from '../convex-typed-rows/fixture.js';
import {readRuns, readTurns, runInternal} from './hosted.js';
import {createWorkflowChat, waitForTerminal} from './run-checks.js';

const Begin = makeFunctionReference<'mutation', {serverToken: string; userId: string}, unknown>('account:begin');
const UserRow = z.object({_id: z.string()});

export async function verifyDeletion(context: StepContext) {
  const {live, owners: [owner], reader} = await hostedFixture(context);
  const {userId} = owner;
  const chatId = await createWorkflowChat(owner);
  const api = typedApi(owner.client);
  const server = new ConvexHttpClient(live.convexUrl, {logger: false});
  const controlRunId = await api.startRun(chatId);
  if (await waitForTerminal(owner, controlRunId) !== 'completed') {
    throw new Error('The deletion control run did not complete');
  }
  const runId = await api.startRun(chatId);
  const begun = await settle(server.mutation(Begin, {serverToken: live.serverToken.reveal(), userId}));
  if (!begun.ok) throw new Error('account:begin failed for the disposable actor');

  const [runs, turns] = await Promise.all([readRuns(reader, userId), readTurns(reader, userId)]);
  const target = runs.find(row => row._id === runId)?.workflow;
  const workflowIds = new Set(runs.flatMap(row => row.workflow?.id ? [row.workflow.id] : []));
  const before = await snapshotJournal(reader, workflowIds);
  const stoppedMidRun = !!target?.id && target.status === 'running' && target.nextTurnIndex < STUB_TURNS_MAX;
  const start = await settle(api.startRun(chatId));
  const commit = await settle(runInternal(context, 'turns:commitStub', {
    userId, chatId, runId, generation: target?.generation ?? 0, expectedTurnIndex: target?.nextTurnIndex ?? 0,
  }));
  const startRejected = !start.ok && errorText(start.error).includes(AUTH_REQUIRED);
  const commitRejected = !commit.ok && errorText(commit.error) === WORKFLOW_ERRORS.unavailable;
  const purge = await purgeUntilDone(live, owner).catch(() => {
    throw new Error('account:purge failed for the disposable actor');
  });
  const [afterRuns, afterTurns, afterJournal, users] = await Promise.all([
    readRuns(reader, userId), readTurns(reader, userId), snapshotJournal(reader, workflowIds), reader('users'),
  ]);
  const remaining = {
    runs: afterRuns.length, turnFlags: afterTurns.length, ...afterJournal,
    users: users.filter(row => UserRow.parse(row)._id === userId).length,
  };
  context.attach('deletion.json', JSON.stringify({
    target: {runId, status: target?.status, nextTurnIndex: target?.nextTurnIndex},
    before: {runs: runs.length, turnFlags: turns.length, ...before}, stoppedMidRun,
    startRejected, commitRejected, purge, remaining,
  }, null, 2));
  if (!stoppedMidRun || !startRejected || !commitRejected || purge.status !== 'pass'
    || before.steps === 0 || before.workflows === 0 || turns.length === 0
    || Object.values(remaining).some(count => count !== 0)) {
    return {status: 'fail' as const, summary: 'Mid-run fence, positive pre-purge counts, or zero post-purge counts did not hold'};
  }
  return {status: 'pass' as const, summary: 'Mid-run deletion fenced start and stub commit, then purged the owner and workflow rows'};
}
