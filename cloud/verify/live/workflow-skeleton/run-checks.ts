import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {makeFunctionReference} from 'convex/server';
import {RunSchema, TurnResultSchema} from '@praxis/protocol';
import type {StepContext} from '@praxis/verify';
import {z} from 'zod';
import {STUB_TURNS_MAX} from '../../../convex/workflows/constants.js';
import {typedApi} from '../convex-typed-rows/api.js';
import {hostedFixture} from '../convex-typed-rows/fixture.js';
import type {LiveOwner} from '../convex-typed-rows/owners.js';
import {readRuns, readTurns, runInternal} from './hosted.js';

const Cancel = makeFunctionReference<'mutation', {runId: string}, unknown>('runs:cancel');
const SETTLE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

export async function createWorkflowChat(owner: LiveOwner): Promise<string> {
  await owner.refresh();
  const chat = await typedApi(owner.client).createChat(`pra125-${randomUUID()}`, 'PRA-125 disposable workflow');
  return chat.id;
}

export async function waitForTerminal(owner: LiveOwner, runId: string) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  const api = typedApi(owner.client);
  let status: z.infer<typeof RunSchema>['status'] | undefined;
  while (Date.now() < deadline) {
    status = (await api.getRun(runId))?.status;
    if (status && TERMINAL_STATUSES.has(status)) return status;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Run did not settle within ${SETTLE_TIMEOUT_MS} ms. Last status: ${status ?? 'missing'}`);
}

export async function verifyCompletion(context: StepContext) {
  const {owners: [owner], reader} = await hostedFixture(context);
  const chatId = await createWorkflowChat(owner);
  const runId = await typedApi(owner.client).startRun(chatId);
  const status = await waitForTerminal(owner, runId);
  const [runs, turns, workflows, steps] = await Promise.all([
    readRuns(reader, owner.userId),
    readTurns(reader, owner.userId),
    reader('workflows', 'workflow'),
    reader('steps', 'workflow'),
  ]);
  const run = runs.find(row => row._id === runId);
  const workflowId = run?.workflow?.id;
  const Id = z.object({_id: z.string()});
  const Step = z.object({workflowId: z.string(), step: z.object({functionType: z.string()})});
  const workflowExists = workflows.some(row => Id.parse(row)._id === workflowId);
  const actionSteps = steps.map(row => Step.safeParse(row).data).filter(
    row => row?.workflowId === workflowId && row?.step.functionType === 'action',
  ).length;
  const flags = turns.filter(turn => turn.runId === runId).sort((a, b) => a.turnIndex - b.turnIndex);
  const expectedFlags = flags.length === STUB_TURNS_MAX && flags.every((turn, index) => {
    const terminal = index === STUB_TURNS_MAX - 1;
    return turn.turnIndex === index && turn.done === terminal && turn.status === (terminal ? 'completed' : 'ready');
  });
  context.attach('completion.json', JSON.stringify({
    workflowId, runId, status, workflowExists, actionSteps, flags,
  }, null, 2));
  if (status !== 'completed' || run?.value.status !== 'completed' || !workflowExists
    || actionSteps !== STUB_TURNS_MAX || !expectedFlags) {
    return {status: 'fail' as const, summary: 'Hosted run, workflow journal, or persisted turn flags did not match completion'};
  }
  return {status: 'pass' as const, summary: 'Authenticated workflow completed with three journaled actions and three persisted turn flags'};
}

export async function verifyCancellation(context: StepContext) {
  const {owners: [owner], reader} = await hostedFixture(context);
  const chatId = await createWorkflowChat(owner);
  const runId = await typedApi(owner.client).startRun(chatId);
  await owner.client.mutation(Cancel, {runId});
  const status = await waitForTerminal(owner, runId);
  const run = (await readRuns(reader, owner.userId)).find(row => row._id === runId);
  const workflow = run?.workflow;
  if (status !== 'cancelled' || run?.value.status !== 'cancelled' || !workflow || workflow.nextTurnIndex >= STUB_TURNS_MAX) {
    return {status: 'fail' as const, summary: `Cancellation settled ${status} at turn ${workflow?.nextTurnIndex ?? 'unknown'}`};
  }
  const expectedTurnIndex = workflow.nextTurnIndex;
  const late = TurnResultSchema.parse(await runInternal(context, 'turns:run', {
    userId: owner.userId, chatId, runId, generation: workflow.generation, expectedTurnIndex,
  }));
  const turnIndices = (await readTurns(reader, owner.userId))
    .filter(turn => turn.runId === runId).map(turn => turn.turnIndex).sort((a, b) => a - b);
  context.attach('cancellation.json', JSON.stringify({runId, status, expectedTurnIndex, late, turnIndices}, null, 2));
  if (late.status !== 'stopped' || !late.done || late.turnIndex !== expectedTurnIndex
    || turnIndices.length !== expectedTurnIndex || !turnIndices.every((index, position) => index === position)) {
    return {status: 'fail' as const, summary: 'Late turn did not return stopped without writing flags'};
  }
  return {status: 'pass' as const, summary: `Run cancelled after ${expectedTurnIndex} committed turns and late delivery stopped`};
}
