import {SealedSecret} from '@praxis/types';
import {DEFAULT_COOLDOWNS_MS, type CredentialSignal} from '@praxis/credentials/classify';
import {pool} from '@praxis/credentials/pool';
import {memoryCooldownStore} from '@praxis/credentials/cooldown';
import {withCredential} from '@praxis/credentials/failover';
import {z} from 'zod';
import {CELERIS_BASE_URL, CELERIS_DECISION_PATH_SEGMENT, CONTEXT_DECISION_MODEL, CONTEXT_DECISION_QUERY_MAX_CHARACTERS, CONTEXT_DECISION_TIMEOUT_MS} from './constants.js';
import type {DecisionPort, DecisionRequest, DecisionResult} from './select.js';

const answerSchema = z.object({type: z.literal('predicate'), name: z.string(), probability: z.number()}).strict();
const responseSchema = z.object({model: z.string(), answers: z.array(answerSchema), usage: z.object({input_tokens: z.number().int().nonnegative()}).passthrough()}).passthrough();

function payload(request: DecisionRequest) {
  return {
    model: CONTEXT_DECISION_MODEL,
    input: request.query.slice(0, CONTEXT_DECISION_QUERY_MAX_CHARACTERS),
    questions: request.candidates.map(candidate => ({type: 'predicate', name: candidate.key, instructions: `The assistant should have ${candidate.kind} «${candidate.title}» (${candidate.summary}) available to handle the user's latest request.`})),
  };
}

export function celerisDecisionPort({key, fetch: fetcher = fetch, signal}: {key: SealedSecret; fetch?: typeof fetch; signal?: AbortSignal}): DecisionPort {
  return {async decide(request): Promise<DecisionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTEXT_DECISION_TIMEOUT_MS);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const response = await fetcher(`${CELERIS_BASE_URL}/${CELERIS_DECISION_PATH_SEGMENT}/v1/decisions`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${key.reveal()}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(payload(request)),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) return {kind: 'failure', reason: 'rate_limited'};
        if (response.status === 402) return {kind: 'failure', reason: 'quota'};
        if (response.status === 401) return {kind: 'failure', reason: 'unauthorized'};
        if (response.status >= 500 || response.status === 404 || response.status === 413) return {kind: 'failure', reason: 'unavailable'};
        return {kind: 'failure', reason: 'invalid_response'};
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.model !== CONTEXT_DECISION_MODEL) return {kind: 'failure', reason: 'invalid_response'};
      return {kind: 'success', probabilities: new Map(parsed.data.answers.map(answer => [answer.name, answer.probability])), usage: {inputTokens: parsed.data.usage.input_tokens}};
    } catch {
      if (controller.signal.aborted) return {kind: 'failure', reason: 'timeout'};
      return {kind: 'failure', reason: 'unavailable'};
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }};
}

function classifyDecision(value: DecisionResult): CredentialSignal {
  if (value.kind !== 'failure') return {kind: 'ok'};
  if (value.reason === 'unauthorized') return {kind: 'invalid', cooldownMs: DEFAULT_COOLDOWNS_MS.invalid};
  if (value.reason === 'quota') return {kind: 'exhausted', cooldownMs: DEFAULT_COOLDOWNS_MS.exhausted};
  if (value.reason === 'rate_limited') return {kind: 'rateLimited', cooldownMs: DEFAULT_COOLDOWNS_MS.rateLimited};
  if (value.reason === 'unavailable' || value.reason === 'timeout') {
    return {kind: 'serverError', cooldownMs: DEFAULT_COOLDOWNS_MS.serverError};
  }
  return {kind: 'ok'};
}

export function pooledCelerisDecisionPort({env, fetch: fetcher = fetch, signal}: {env: Record<string, string | undefined>; fetch?: typeof fetch; signal?: AbortSignal}): DecisionPort {
  const credentials = pool('CELERIS_API_KEY', env, {service: 'celeris'});
  const cooldowns = memoryCooldownStore();
  if (!credentials.slots.length) return {decide: async () => ({kind: 'failure', reason: 'no_key'})};
  return {async decide(request) {
    try {
      const result = await withCredential(credentials, cooldowns, async key => celerisDecisionPort({key, fetch: fetcher, signal}).decide(request), {
        classify: classifyDecision,
      });
      return result.value;
    } catch {
      return {kind: 'failure', reason: 'unavailable'};
    }
  }};
}
