import {setTimeout as sleep} from 'node:timers/promises';
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

export interface HostedResponse<T> {
  status: number;
  body: T;
}

export interface ErrorBody {
  code?: string;
  message?: string;
}

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

/** Never throws on an HTTP error: live checks assert on rejected requests as often as on accepted ones. */
export async function hosted<T = Record<string, unknown>>(context: StepContext, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<HostedResponse<T>> {
  const response = await fetch(`${origin(context)}${path}`, {
    method,
    headers: {authorization: `Bearer ${context.secret(HOSTED_TOKEN).reveal()}`, ...(body === undefined ? {} : {'content-type': 'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    redirect: 'error',
    signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {message: text.slice(0, 500)};
  }
  context.log(`${method} ${path} → ${response.status}`);
  return {status: response.status, body: parsed as T};
}

export interface HostedRun {
  run: {id: string; status: string; outcome?: string; errorCode?: string; error?: string};
  blocks: {type: string; text?: string}[];
  usage?: {inputTokens: number; outputTokens: number; cost?: number};
}

async function newChat(context: StepContext, input: {modelId?: string; effort?: string}): Promise<string> {
  const chat = await hosted<{id: string}>(context, '/v1/chats', {type: 'chat.input', title: 'praxis-verify live', ...(input.modelId ? {modelId: input.modelId} : {}), ...(input.effort ? {effort: input.effort} : {})});
  if (chat.status >= 300) throw new Error(`creating a chat failed: HTTP ${chat.status}`);
  return chat.body.id;
}

/** Starts a turn (in a fresh chat unless one is given) and polls its snapshot until it settles. */
export async function hostedTurn(context: StepContext, input: {text: string; chatId?: string; modelId?: string; effort?: string}): Promise<HostedRun & {chatId: string}> {
  const chatId = input.chatId ?? await newChat(context, input);
  const started = await hosted<{id: string}>(context, '/v1/runs', {type: 'run.start', chatId, text: input.text});
  if (started.status >= 300) throw new Error(`starting the run failed: HTTP ${started.status}`);
  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await hosted<HostedRun>(context, `/v1/runs/${started.body.id}/snapshot`);
    if (snapshot.status === 200 && SETTLED.has(snapshot.body.run.status)) return {...snapshot.body, chatId};
    await sleep(RUN_POLL_INTERVAL_MS);
  }
  throw new Error(`run ${started.body.id} did not settle within ${RUN_SETTLE_TIMEOUT_MS} ms`);
}

export function replyText(run: HostedRun): string {
  return run.blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('');
}
