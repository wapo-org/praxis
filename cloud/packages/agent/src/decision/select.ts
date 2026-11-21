import {CONTEXT_DECISION_MIN_CANDIDATES, CONTEXT_DECISION_THRESHOLD, CONTEXT_FALLBACK_TOP_K, CONTEXT_KIND_ORDER, CONTEXT_PER_KIND_MAX} from './constants.js';

export type CandidateKind = keyof typeof CONTEXT_PER_KIND_MAX;
export interface Candidate {
  key: string;
  kind: CandidateKind;
  title: string;
  summary: string;
  score: number;
}
export type FallbackReason = 'no_key' | 'timeout' | 'rate_limited' | 'quota' | 'unavailable' | 'invalid_response' | 'allowance';
export type DecisionResult = {kind: 'success'; probabilities: ReadonlyMap<string, number>; usage?: {inputTokens: number}} | {kind: 'failure'; reason: FallbackReason | 'unauthorized'};
export interface DecisionRequest {query: string; candidates: readonly Candidate[]}
export interface DecisionPort {decide(request: DecisionRequest): Promise<DecisionResult>}
export interface Selection {chosen: Candidate[]; selection: 'all' | 'decision' | 'fallback'; reason?: FallbackReason; usage?: {inputTokens: number}}

function sortCandidates(candidates: readonly Candidate[]): Candidate[] {
  const order = new Map<string, number>(CONTEXT_KIND_ORDER.map((kind, index) => [kind, index]));
  return [...candidates].sort((a, b) => b.score - a.score || order.get(a.kind)! - order.get(b.kind)! || a.key.localeCompare(b.key));
}

function capByKind(candidates: readonly Candidate[]): Candidate[] {
  const counts = new Map<CandidateKind, number>();
  return candidates.filter(candidate => {
    const count = counts.get(candidate.kind) ?? 0;
    if (count >= CONTEXT_PER_KIND_MAX[candidate.kind]) return false;
    counts.set(candidate.kind, count + 1);
    return true;
  });
}

function fallback(candidates: readonly Candidate[], reason: FallbackReason): Selection {
  return {chosen: capByKind(sortCandidates(candidates).slice(0, CONTEXT_FALLBACK_TOP_K)), selection: 'fallback', reason};
}

export async function selectCandidates({query, candidates, port, sendsMemories = true}: DecisionRequest & {port: DecisionPort; sendsMemories?: boolean}): Promise<Selection> {
  const unique = [...new Map(candidates.map(candidate => [candidate.key, candidate])).values()];
  const eligible = sendsMemories ? unique : unique.filter(candidate => candidate.kind !== 'memory');
  const memories = sendsMemories ? [] : unique.filter(candidate => candidate.kind === 'memory');
  if (eligible.length <= CONTEXT_DECISION_MIN_CANDIDATES) return {chosen: capByKind(sortCandidates([...eligible, ...memories])), selection: 'all'};
  const result = await port.decide({query, candidates: eligible});
  if (result.kind === 'failure') return fallback([...eligible, ...memories], result.reason === 'unauthorized' ? 'unavailable' : result.reason);
  if (result.probabilities.size !== eligible.length || eligible.some(candidate => {
    const probability = result.probabilities.get(candidate.key);
    return probability === undefined || !Number.isFinite(probability) || probability < 0 || probability > 1;
  })) return fallback([...eligible, ...memories], 'invalid_response');
  const chosen = eligible.filter(candidate => result.probabilities.get(candidate.key)! >= CONTEXT_DECISION_THRESHOLD)
    .sort((a, b) => result.probabilities.get(b.key)! - result.probabilities.get(a.key)! || a.key.localeCompare(b.key));
  return {chosen: capByKind([...chosen, ...memories]), selection: 'decision', ...(result.usage ? {usage: result.usage} : {})};
}
