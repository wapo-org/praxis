import { describe, expect, it } from 'vitest';
import type { Model, Provider } from '@praxis/protocol';
import { decideSelection, fallbackModel } from './modelSelection';

const provider = (id: string, defaultModel?: string) => ({ type: 'provider', id, name: id, defaultModel }) as unknown as Provider;
const model = (providerId: string, id: string) => ({ type: 'model', providerId, id, displayName: `${providerId}:${id}` }) as unknown as Model;
const scripted = model('scripted', 'scripted');
const muse = model('router', 'muse');
const lumen = model('router', 'lumen');
const providers = [provider('scripted'), provider('router', 'lumen')];
const models = [scripted, muse, lumen];
const ref = (m: Model) => ({ providerId: m.providerId, modelId: m.id });
const none = { providerId: '', modelId: '' };

describe('model selection (WP-K2b)', () => {
  it('never falls back to the scripted provider while a real one exists, and prefers its default model', () => {
    expect(fallbackModel(models, providers)).toBe(lumen);
    expect(fallbackModel(models, [provider('scripted'), provider('router')])).toBe(muse);
    expect(fallbackModel([scripted], [provider('scripted')])).toBe(scripted);
  });
  it('keeps a valid selection whatever else changes', () => {
    expect(decideSelection({ chatChanged: false, current: ref(muse), models, providers, ready: true })).toEqual({ kind: 'keep' });
    expect(decideSelection({ chatChanged: true, current: ref(muse), models, providers, ready: false })).toEqual({ kind: 'keep' });
  });
  it('opening a chat selects the model of that chat', () => {
    expect(decideSelection({ chatChanged: true, chatModel: ref(scripted), current: ref(muse), models, providers, ready: true })).toEqual({ kind: 'select', ref: ref(scripted) });
  });
  it('waits for the full list before replacing a missing selection, then says so', () => {
    const saved = { providerId: 'router', modelId: 'later' };
    expect(decideSelection({ chatChanged: true, current: saved, models, providers, ready: false })).toEqual({ kind: 'wait' });
    expect(decideSelection({ chatChanged: true, chatModel: saved, current: none, models, providers, ready: false })).toEqual({ kind: 'wait' });
    const after = decideSelection({ chatChanged: false, current: saved, models, providers, ready: true });
    expect(after).toMatchObject({ kind: 'select', ref: ref(lumen) });
    expect(after.kind === 'select' && after.notice).toMatch(/no longer available/);
    expect(decideSelection({ chatChanged: true, current: none, models, providers, ready: true })).toEqual({ kind: 'select', ref: ref(lumen) });
  });
});
