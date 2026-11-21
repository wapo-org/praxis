import {v} from 'convex/values';

/** A run's address below its owner; server functions get the owner from the token-vouched `userId`. */
const ownerRunScope = {chatId: v.string(), runId: v.id('runs'), generation: v.number()};
export const runScope = {userId: v.string(), ...ownerRunScope};
export const terminalStatus = v.union(v.literal('completed'), v.literal('cancelled'), v.literal('failed'));
/** `continued` ends a generation that handed the run to its successor; the run itself is still active. */
export const generationOutcome = v.union(terminalStatus, v.literal('continued'));
