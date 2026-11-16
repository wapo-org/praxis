import type { ModelListItem as Model } from '@praxis/protocol';

/** WP-K2b: which model is selected, and when that may change without the user choosing. */
export interface ModelRef {
  modelId: string;
}

const SCRIPTED = 'scripted';

export const sameRef = (a?: ModelRef | null, b?: ModelRef | null) =>
  !!a && !!b && a.modelId === b.modelId;

/** A selection is valid while its model is in the list and its provider still exists. */
export function isAvailable(ref: ModelRef | null | undefined, models: readonly Model[]): boolean {
  return (
    !!ref?.modelId &&
    models.some((m) => m.id === ref.modelId)
  );
}

export function fallbackModel(models: readonly Model[]): Model | undefined {
  return models.find(m => m.recommended) ?? models[0];
}

export type SelectionDecision =
  | { kind: 'keep' }
  /** The list is not complete yet: decide once it is. */
  | { kind: 'wait' }
  | { kind: 'select'; ref: ModelRef; notice?: string };

export function decideSelection(input: {
  chatChanged: boolean;
  chatModel?: ModelRef;
  current: ModelRef;
  models: readonly Model[];
  ready: boolean;
}): SelectionDecision {
  const { chatChanged, chatModel, current, models, ready } = input;
  if (chatChanged && chatModel) {
    if (isAvailable(chatModel, models)) return sameRef(chatModel, current) ? { kind: 'keep' } : { kind: 'select', ref: chatModel };
    if (!ready) return { kind: 'wait' };
    const next = fallbackModel(models);
    return next
      ? { kind: 'select', ref: { modelId: next.id }, notice: `The previous model is no longer available. Switched to ${next.name}.` }
      : { kind: 'keep' };
  }
  if (isAvailable(current, models)) return { kind: 'keep' };
  if (!ready) return { kind: 'wait' };
  const next = fallbackModel(models);
  if (!next) return { kind: 'keep' };
  const ref = { modelId: next.id };
  return sameRef(ref, current) ? { kind: 'keep' } : { kind: 'select', ref, ...(current.modelId ? { notice: `The selected model is no longer available. Switched to ${next.name}.` } : {}) };
}

/** The last selection per account and API, so a reload starts from it instead of the first model. */
const storageKey = (account: string | undefined) => (account ? `praxis-model:${account}` : undefined);
export function readStoredSelection(account: string | undefined): ModelRef | null {
  const key = storageKey(account);
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as ModelRef | null;
    return value && typeof value.modelId === 'string' ? value : null;
  } catch {
    return null;
  }
}
export function writeStoredSelection(account: string | undefined, ref: ModelRef) {
  const key = storageKey(account);
  if (!key || typeof localStorage === 'undefined' || !ref.modelId) return;
  localStorage.setItem(key, JSON.stringify(ref));
}
