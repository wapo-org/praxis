import {v} from 'convex/values';

export const runScope = {
  userId: v.string(), chatId: v.string(), runId: v.id('runs'), generation: v.number(),
};
export const terminalStatus = v.union(v.literal('completed'), v.literal('cancelled'), v.literal('failed'));
