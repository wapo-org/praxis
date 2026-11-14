import type { Model, Provider } from '@praxis/protocol';

/** WP-K2b: which model is selected, and when that may change without the user choosing. */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

const SCRIPTED = 'scripted';

export const sameRef = (a?: ModelRef | null, b?: ModelRef | null) =>
  !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId;

/** A selection is valid while its model is in the list and its provider still exists. */
export function isAvailable(ref: ModelRef | null | undefined, models: readonly Model[], providers: readonly Provider[]): boolean {
  return (
    !!ref?.providerId &&
    !!ref.modelId &&
    models.some((m) => m.providerId === ref.providerId && m.id === ref.modelId) &&
    providers.some((p) => p.id === ref.providerId)
  );
}

/**
 * The model to use when nothing valid is selected: a real provider's default model, else its first model;
 * the scripted provider only when there is no real one.
 */
export function fallbackModel(models: readonly Model[], providers: readonly Provider[]): Model | undefined {
  const usable = models.filter((m) => providers.some((p) => p.id === m.providerId));
  const real = providers.filter((p) => p.id !== SCRIPTED);
  for (const provider of real) {
    const preferred = usable.find((m) => m.providerId === provider.id && m.id === provider.defaultModel);
    if (preferred) return preferred;
  }
  return usable.find((m) => m.providerId !== SCRIPTED) ?? usable[0];
}

export type SelectionDecision =
  | { kind: 'keep' }
  /** The list is not complete yet: decide once it is. */
  | { kind: 'wait' }
  | { kind: 'select'; ref: ModelRef; notice?: string };

/**
 * One rule for every automatic change (WP-K2b):
 * - opening a chat selects that chat's model;
 * - otherwise a valid selection is never replaced;
 * - an invalid one is replaced only once the full model list has loaded (`ready`), and then by a real
 *   provider's model before the scripted one.
 */
export function decideSelection(input: {
  chatChanged: boolean;
  chatModel?: ModelRef;
  current: ModelRef;
  models: readonly Model[];
  providers: readonly Provider[];
  ready: boolean;
}): SelectionDecision {
  const { chatChanged, chatModel, current, models, providers, ready } = input;
  if (chatChanged && chatModel) {
    if (isAvailable(chatModel, models, providers)) return sameRef(chatModel, current) ? { kind: 'keep' } : { kind: 'select', ref: chatModel };
    if (!ready) return { kind: 'wait' };
    const next = fallbackModel(models, providers);
    return next
      ? { kind: 'select', ref: { providerId: next.providerId, modelId: next.id }, notice: `The previous model is no longer available. Switched to ${next.displayName}.` }
      : { kind: 'keep' };
  }
  if (isAvailable(current, models, providers)) return { kind: 'keep' };
  if (!ready) return { kind: 'wait' };
  const next = fallbackModel(models, providers);
  if (!next) return { kind: 'keep' };
  const ref = { providerId: next.providerId, modelId: next.id };
  return sameRef(ref, current) ? { kind: 'keep' } : { kind: 'select', ref, ...(current.modelId ? { notice: `The selected model is no longer available. Switched to ${next.displayName}.` } : {}) };
}

/** The last selection per account and API, so a reload starts from it instead of the first model. */
const storageKey = (account: string | undefined) => (account ? `praxis-model:${account}` : undefined);
export function readStoredSelection(account: string | undefined): ModelRef | null {
  const key = storageKey(account);
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as ModelRef | null;
    return value && typeof value.providerId === 'string' && typeof value.modelId === 'string' ? value : null;
  } catch {
    return null;
  }
}
export function writeStoredSelection(account: string | undefined, ref: ModelRef) {
  const key = storageKey(account);
  if (!key || typeof localStorage === 'undefined' || !ref.providerId || !ref.modelId) return;
  localStorage.setItem(key, JSON.stringify(ref));
}
