import { describe, expect, it } from 'vitest';
import type { ModelListItem as Model } from '@praxis/protocol';
import { decideSelection, fallbackModel } from './modelSelection';

const model = (providerId: string, id: string) => ({ type: 'catalogModel', id, name: id, recommended: id === 'lumen' }) as unknown as Model;
const scripted = model('scripted', 'scripted');
const muse = model('router', 'muse');
const lumen = model('router', 'lumen');
const models = [scripted, muse, lumen];
const ref = (m: Model) => ({ modelId: m.id });
const none = { modelId: '' };

describe('model selection (WP-K2b)', () => {
  it('never falls back to the scripted provider while a real one exists, and prefers its default model', () => {
    expect(fallbackModel(models)).toBe(lumen);
    expect(fallbackModel([scripted])).toBe(scripted);
  });
  it('keeps a valid selection whatever else changes', () => {
    expect(decideSelection({ chatChanged: false, current: ref(muse), models, ready: true })).toEqual({ kind: 'keep' });
    expect(decideSelection({ chatChanged: true, current: ref(muse), models, ready: false })).toEqual({ kind: 'keep' });
  });
  it('opening a chat selects the model of that chat', () => {
    expect(decideSelection({ chatChanged: true, chatModel: ref(scripted), current: ref(muse), models, ready: true })).toEqual({ kind: 'select', ref: ref(scripted) });
  });
  it('waits for the full list before replacing a missing selection, then says so', () => {
    const saved = { modelId: 'later' };
    expect(decideSelection({ chatChanged: true, current: saved, models, ready: false })).toEqual({ kind: 'wait' });
    expect(decideSelection({ chatChanged: true, chatModel: saved, current: none, models, ready: false })).toEqual({ kind: 'wait' });
    const after = decideSelection({ chatChanged: false, current: saved, models, ready: true });
    expect(after).toMatchObject({ kind: 'select', ref: ref(lumen) });
    expect(after.kind === 'select' && after.notice).toMatch(/no longer available/);
    expect(decideSelection({ chatChanged: true, current: none, models, ready: true })).toEqual({ kind: 'select', ref: ref(lumen) });
  });
});
