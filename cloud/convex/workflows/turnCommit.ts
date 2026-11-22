import {ConvexError} from 'convex/values';
import {
  JsonObjectSchema, TURN_INDEX_MAX, TurnResultSchema,
  type Message, type RunTaint, type TurnCommit, type TurnCommitEnd, type TurnCommitResult, type TurnFailure, type TurnResult,
} from '@praxis/protocol';
import type {Doc} from '../_generated/dataModel.js';
import type {MutationCtx} from '../functions.js';
import {ownedApproval} from '../approvalRecords.js';
import {domainDocument, keptRunTaint} from '../domainRecords.js';
import {liveScopedRun} from '../runs.js';
import {writeRecord} from '../store.js';
import {WORKFLOW_ERRORS} from './constants.js';
import {clearLedger} from '../agent/ledger.js';
import {markOutputsCommitted} from '../outputs.js';
import {turnState, type TurnScope} from './turnState.js';

const CONFLICT: TurnCommitResult = {outcome: 'conflict'};

async function writeTurnMessage(ctx: MutationCtx, commit: TurnCommit, message: Message) {
  const ownRun = message.role === 'assistant' && message.chatId === commit.chatId && message.runId === commit.runId;
  if (!ownRun || await domainDocument(ctx, commit.userId, 'message', message.id)) {
    throw new ConvexError(WORKFLOW_ERRORS.message);
  }
  // The typed writer allocates the chat sequence and sync revision inside this transaction.
  await writeRecord(ctx, {
    userId: commit.userId, kind: 'message', id: message.id, parentId: message.chatId,
    value: JsonObjectSchema.parse(message), deleted: false,
  });
}

function assertTaintRecorded(messages: Message[], taint: RunTaint | undefined) {
  const marked = messages.some(message => message.parts.some(part => part.taintSource !== undefined));
  if (marked && !taint) throw new ConvexError(WORKFLOW_ERRORS.taint);
}

async function assertPendingApproval(ctx: MutationCtx, run: Doc<'runs'>, end: TurnCommitEnd) {
  if (end.status !== 'suspended') return;
  const approval = await ownedApproval(ctx, run.userId, end.approvalId);
  if (approval?.status !== 'pending' || approval.runId !== run.id || approval.toolCallId !== end.callId) {
    throw new ConvexError(WORKFLOW_ERRORS.approval);
  }
}

function storedUsage(usage: TurnCommit['usage']) {
  if (!usage) return {};
  const {type: _type, ...counts} = usage;
  return {usage: counts};
}

/** A restart can reuse the cursor, so the generation is part of the fence, not only of the run lookup. */
function fenceHolds(run: Doc<'runs'>, commit: Pick<TurnCommit, 'generation' | 'expectedTurnIndex'>): boolean {
  return run.value.status === 'running'
    && run.workflow?.generation === commit.generation
    && run.workflow.nextTurnIndex === commit.expectedTurnIndex;
}

/** Compare-and-set on the run's cursor: a stale index or generation, or a run no longer running, writes nothing. */
export async function commitTurn(ctx: MutationCtx, commit: TurnCommit): Promise<TurnCommitResult> {
  const runId = ctx.db.normalizeId('runs', commit.runId);
  if (!runId) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
  const run = await liveScopedRun(ctx, {...commit, runId});
  if (!run || !fenceHolds(run, commit)) return CONFLICT;
  const turnIndex = commit.expectedTurnIndex;
  if (turnIndex >= TURN_INDEX_MAX) throw new ConvexError(WORKFLOW_ERRORS.exhausted);
  const taint = keptRunTaint(run.value.taint, commit.taint);
  assertTaintRecorded(commit.messages, taint);
  await assertPendingApproval(ctx, run, commit.end);
  for (const message of commit.messages) await writeTurnMessage(ctx, commit, message);
  await markOutputsCommitted(ctx, commit.userId, commit.chatId, commit.messages);
  await clearLedger(ctx, {...commit, runId});
  const done = commit.end.status === 'completed';
  const status = done ? 'completed' : 'ready';
  const suspension = commit.end.status === 'suspended'
    ? {suspension: {callId: commit.end.callId, approvalId: commit.end.approvalId}}
    : {};
  await ctx.db.insert('turns', {
    userId: commit.userId, runId, generation: commit.generation, turnIndex, done, status,
    ...storedUsage(commit.usage), ...suspension,
  });
  const updatedAt = new Date().toISOString();
  await ctx.db.patch(runId, {
    updatedAt,
    value: {
      ...run.value, updatedAt, ...(taint && {taint}),
      ...(commit.end.status === 'suspended' && {status: 'paused' as const}),
    },
    workflow: {...run.workflow, nextTurnIndex: turnIndex + 1},
  });
  return {outcome: 'committed', flags: TurnResultSchema.parse({done, status, subagents: [], turnIndex})};
}

/** Ends the run as failed with the user-fixable reason; a turn the run no longer holds returns its saved flags. */
export async function failTurn(ctx: MutationCtx, scope: TurnScope, failure: TurnFailure): Promise<TurnResult> {
  const run = await liveScopedRun(ctx, scope);
  if (!run || !fenceHolds(run, scope)) {
    const state = await turnState(ctx, scope);
    if (state.state === 'settled') return state.flags;
    throw new ConvexError(WORKFLOW_ERRORS.index);
  }
  const updatedAt = new Date().toISOString();
  await clearLedger(ctx, scope);
  await ctx.db.patch(run._id, {
    updatedAt, value: {...run.value, status: 'failed', updatedAt, error: failure.message, errorCode: failure.code},
  });
  return TurnResultSchema.parse({done: true, status: 'failed', failure, subagents: [], turnIndex: scope.expectedTurnIndex});
}
