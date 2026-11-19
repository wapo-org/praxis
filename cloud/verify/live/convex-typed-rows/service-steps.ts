import {setTimeout as pause} from 'node:timers/promises';
import {RunSchema} from '@praxis/protocol';
import type {StepContext, StepOutcome} from '@praxis/verify';
import {makeFunctionReference} from 'convex/server';
import {z} from 'zod';
import {
  assertOwnerPurged, assertOwnerUnchanged, beginFencesOwner, commitConcurrently, purgeUntilDone,
  recommitKeepsSequence, rejectsBadCredential, snapshotOwner, TYPED_TABLES, type StepResult,
} from './commit-purge.js';
import {hostedFixture} from './fixture.js';
import type {LiveOwner} from './owners.js';

const StartRun = makeFunctionReference<'mutation'>('runs:start');
const GetRun = makeFunctionReference<'query'>('runs:get');
const WORKFLOW_TIMEOUT_MS = 45_000;
const WORKFLOW_POLL_MS = 500;

function outcome(context: StepContext, results: readonly StepResult[]): StepOutcome {
  for (const result of results) {
    for (const line of result.log) context.log(line);
  }
  return {
    status: results.some(result => result.status === 'fail') ? 'fail' : 'pass',
    summary: results.map(result => result.summary).join('. '),
  };
}

async function settledWorkflow(owner: LiveOwner, chatId: string): Promise<void> {
  const runId = z.string().parse(await owner.client.mutation(StartRun, {chatId}));
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = RunSchema.parse(await owner.client.query(GetRun, {runId}));
    if (run.status === 'completed') return;
    if (run.status !== 'running') throw new Error(`Fixture workflow ended with status ${run.status}`);
    await pause(WORKFLOW_POLL_MS);
  }
  throw new Error('Fixture workflow did not settle');
}

export async function verifyCommit(context: StepContext): Promise<StepOutcome> {
  const {live, owners: [owner]} = await hostedFixture(context);
  const {result, chatId, committed} = await commitConcurrently(live, owner);
  const denied = await rejectsBadCredential(live, owner, chatId);
  const first = committed[0];
  if (!first) return outcome(context, [result, denied]);
  return outcome(context, [result, await recommitKeepsSequence(live, owner, chatId, first), denied]);
}

export async function verifyPurge(context: StepContext): Promise<StepOutcome> {
  const {live, reader, owners: [owner, other]} = await hostedFixture(context);
  const own = await commitConcurrently(live, owner, 1, 1);
  const keep = await commitConcurrently(live, other, 1, 1);
  if (own.result.status === 'fail' || keep.result.status === 'fail') {
    return outcome(context, [own.result, keep.result]);
  }
  await settledWorkflow(owner, own.chatId);
  const [before, neighbor] = await Promise.all([
    snapshotOwner(reader, owner.userId),
    snapshotOwner(reader, other.userId),
  ]);
  context.log(`before purge: ${TYPED_TABLES.map(table => `${table}=${before.counts[table]}`).join(' ')}`);
  if (before.workflowIds.size === 0 || before.counts.turns === 0) {
    throw new Error('Fixture workflow did not create a typed turn and journal');
  }
  const fenced = await beginFencesOwner(live, owner, own.chatId);
  const purged = await purgeUntilDone(live, owner);
  const [remaining, unchanged] = await Promise.all([
    assertOwnerPurged(live, reader, owner, before.workflowIds),
    assertOwnerUnchanged(reader, other, neighbor.counts, keep.chatId, keep.committed),
  ]);
  return outcome(context, [fenced, purged, remaining, unchanged]);
}
