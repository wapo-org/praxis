import type {DecisionPort, DecisionRequest, DecisionResult} from './select.js';

export function fakeDecisionPort(result: DecisionResult | ((request: DecisionRequest) => DecisionResult | Promise<DecisionResult>)): DecisionPort {
  return {decide: async request => typeof result === 'function' ? result(request) : result};
}
