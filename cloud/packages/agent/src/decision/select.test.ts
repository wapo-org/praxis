import {describe, expect, it, vi} from 'vitest';
import {fakeDecisionPort, selectCandidates, type Candidate} from './index.js';

const candidates: Candidate[] = Array.from({length: 20}, (_, index) => ({key: `k${index}`, kind: index % 2 ? 'tool' : 'skill', title: `Candidate ${index}`, summary: 'summary', score: 20 - index}));

describe('context decision selection', () => {
  it('includes small sets without calling the decision port', async () => {
    const decide = vi.fn();
    const result = await selectCandidates({query: 'question', candidates: candidates.slice(0, 6), port: {decide}});
    expect(result.selection).toBe('all');
    expect(decide).not.toHaveBeenCalled();
  });

  it('applies probabilities and per-kind limits', async () => {
    const port = fakeDecisionPort({kind: 'success', probabilities: new Map(candidates.map(candidate => [candidate.key, 0.8]))});
    const result = await selectCandidates({query: 'question', candidates, port});
    expect(result.selection).toBe('decision');
    expect(result.chosen).toHaveLength(9);
  });

  it('uses deterministic score-ordered fallback', async () => {
    const port = fakeDecisionPort({kind: 'failure', reason: 'timeout'});
    const result = await selectCandidates({query: 'question', candidates, port});
    expect(result.selection).toBe('fallback');
    expect(result.chosen.map(candidate => candidate.key)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k7']);
  });
});
