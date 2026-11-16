import {setTimeout as sleep} from 'node:timers/promises';
import {ChatSchema, ErrorSchema, MessageSchema, PageSchema, RunSchema, RunSnapshotSchema, type Message, type RunSnapshot} from '@praxis/protocol';
import type {z} from 'zod';
import {API_REQUEST_TIMEOUT_MS} from '../constants.js';
import type {StepContext, StepNeeds} from './types.js';

/** A deployed API origin and a session bearer for a throwaway live-check account. */
export const HOSTED_API_URL = 'PRAXIS_LIVE_API_URL';
export const HOSTED_TOKEN = 'PRAXIS_LIVE_TOKEN';
export const HOSTED_NEEDS: StepNeeds = {secrets: [HOSTED_TOKEN], config: [HOSTED_API_URL]};
/** A hosted model turn with tools stays well under this; beyond it the run is stuck, not slow. */
const RUN_SETTLE_TIMEOUT_MS = 180_000;
const RUN_POLL_INTERVAL_MS = 2_000;
// Parked states count as settled: a live step asserts on them instead of waiting out the timeout.
const SETTLED = new Set(['completed', 'failed', 'cancelled', 'awaitingApproval', 'awaitingElicitation']);

/** Accepted answers are parsed with the protocol schema; rejected ones with `ErrorSchema`, since steps assert on both. */
export type HostedResult<T> = {ok: true; status: number; data: T} | {ok: false; status: number; error: z.infer<typeof ErrorSchema>};

/** Merges the step's own needs with the hosted API's, so either missing skips the step. */
export function withHosted(needs: StepNeeds = {}): StepNeeds {
  return {
    ...needs,
    secrets: [...(HOSTED_NEEDS.secrets ?? []), ...(needs.secrets ?? [])],
    config: [...(HOSTED_NEEDS.config ?? []), ...(needs.config ?? [])],
  };
}

function origin(context: StepContext): string {
  const url = new URL(context.config(HOSTED_API_URL));
  if (url.protocol !== 'https:') throw new Error(`${HOSTED_API_URL} must be an https origin`);
  return url.origin;
}

/** Throws when a response violates the protocol: a malformed answer must fail the step, never pass it. */
export async function hosted<S extends z.ZodType>(context: StepContext, path: string, schema: S, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<HostedResult<z.infer<S>>> {
  const response = await fetch(`${origin(context)}${path}`, {
    method,
    headers: {authorization: `Bearer ${context.secret(HOSTED_TOKEN).reveal()}`, ...(body === undefined ? {} : {'content-type': 'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    redirect: 'error',
    signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
  });
  context.log(`${method} ${path} → ${response.status}`);
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ErrorSchema.safeParse(json);
    if (!error.success) throw new Error(`${method} ${path}: HTTP ${response.status} without a protocol error body`);
    return {ok: false, status: response.status, error: error.data};
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${method} ${path}: response violates the protocol: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  return {ok: true, status: response.status, data: parsed.data};
}

export function expectOk<T>(result: HostedResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: HTTP ${result.status} ${result.error.code}: ${result.error.message}`);
  return result.data;
}

export type HostedTurn = RunSnapshot & {chatId: string};

/** Starts a turn (in a fresh chat unless one is given) and polls its snapshot until it settles. */
export async function hostedTurn(context: StepContext, input: {text: string; chatId?: string; modelId?: string; effort?: string}): Promise<HostedTurn> {
  const chatInput = {type: 'chat.input', title: 'praxis-verify live', ...(input.modelId ? {modelId: input.modelId} : {}), ...(input.effort ? {effort: input.effort} : {})};
  const chatId = input.chatId ?? expectOk(await hosted(context, '/v1/chats', ChatSchema, chatInput), 'creating a chat').id;
  const run = expectOk(await hosted(context, '/v1/runs', RunSchema, {type: 'run.start', chatId, text: input.text}), 'starting the run');
  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = expectOk(await hosted(context, `/v1/runs/${run.id}/snapshot`, RunSnapshotSchema), 'reading the run snapshot');
    if (SETTLED.has(snapshot.run.status)) return {...snapshot, chatId};
    await sleep(RUN_POLL_INTERVAL_MS);
  }
  throw new Error(`run ${run.id} did not settle within ${RUN_SETTLE_TIMEOUT_MS} ms`);
}

export async function chatMessages(context: StepContext, chatId: string): Promise<Message[]> {
  return expectOk(await hosted(context, `/v1/chats/${chatId}/messages`, PageSchema(MessageSchema)), 'reading chat messages').items;
}

export function replyText(run: RunSnapshot): string {
  return run.blocks.filter(block => block.type === 'text').map(block => block.text).join('');
}
