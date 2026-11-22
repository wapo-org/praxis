import type {Message, TurnCommit} from '@praxis/protocol';

const NOW = '2026-11-20T00:00:00.000Z';
const PLANNED_TURNS = 3;

export type TurnScope = Pick<TurnCommit, 'userId' | 'chatId' | 'runId' | 'generation' | 'expectedTurnIndex'>;
export type TurnPlan = Pick<TurnCommit, 'end'> & Partial<Pick<TurnCommit, 'messages' | 'usage' | 'taint'>>;

export function assistantMessage(request: TurnScope, parts: Message['parts'] = [{type: 'text', text: 'answer'}]): Message {
  return {
    type: 'message', id: `${request.runId}-turn-${request.expectedTurnIndex}`, chatId: request.chatId,
    runId: request.runId, role: 'assistant', createdAt: NOW, updatedAt: NOW, parts,
  };
}

function defaultPlan(request: TurnScope): TurnPlan {
  const last = request.expectedTurnIndex + 1 >= PLANNED_TURNS;
  return {end: {status: last ? 'completed' : 'ready'}, messages: [assistantMessage(request)]};
}

/** Arguments for `turns.commitInternal`, the harness's fenced write path. */
export function commitArgs(request: TurnScope, plan: TurnPlan = defaultPlan(request)) {
  const {userId, chatId, runId, generation, expectedTurnIndex} = request;
  const commit: TurnCommit = {
    userId, chatId, runId, generation, expectedTurnIndex,
    messages: plan.messages ?? [],
    end: plan.end,
    ...(plan.usage && {usage: plan.usage}),
    ...(plan.taint && {taint: plan.taint}),
  };
  return {commitJson: JSON.stringify(commit)};
}
