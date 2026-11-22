import { REASONING_EFFORTS, type CatalogModel } from '@praxis/protocol';

/** `1000000` → `1M`, `128000` → `128K`, `8192` → `8K`. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

export function getUnpinnedModels<T extends { pinned?: boolean; favorite?: boolean }>(models: readonly T[]) {
  return models.filter((model) => !model.pinned && !model.favorite);
}

const trim = (value: number) => (Math.round(value * 100) / 100).toString();

/** OpenRouter prices are USD per token, as strings. Shown per million tokens; null when unknown or variable. */
export function pricePerMillion(perToken: string): number | null {
  const value = Number(perToken);
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null;
}

function dollars(value: number): string {
  if (value === 0) return '$0';
  return `$${value >= 10 ? Math.round(value) : value >= 1 ? trim(Math.round(value * 10) / 10) : trim(value)}`;
}

/** `$3 in · $15 out per 1M`, `Free`, or `Variable price` for routers that price per request. */
export function formatPrice(pricing: CatalogModel['pricing']): string {
  const input = pricePerMillion(pricing.prompt);
  const output = pricePerMillion(pricing.completion);
  if (input === null || output === null) return 'Variable price';
  if (input === 0 && output === 0) return 'Free';
  return `${dollars(input)} in · ${dollars(output)} out per 1M`;
}

/** The one-line detail under a model's name: its context window and price. */
export function modelDetail(model: Pick<CatalogModel, 'contextLength' | 'pricing'>): string {
  return `${formatContext(model.contextLength)} context · ${formatPrice(model.pricing)}`;
}

/** Effort levels to offer for a model: the fixed OpenRouter set when its entry supports reasoning. */
export function effortsFor(model: Pick<CatalogModel, 'capabilities'> | undefined): readonly string[] {
  return model?.capabilities.reasoning ? REASONING_EFFORTS : [];
}

/** `dev:local` only: the server's deterministic models, which need no OpenRouter key. */
export const isScriptedModel = (modelId: string | undefined) =>
  modelId === 'scripted' || modelId === 'scripted-vision';

/** Remaining credit on a key: `$19.50 of $25.00 left`, or `No limit` when OpenRouter reports none. */
export function formatCredit(key: { limit?: number | null; limitRemaining?: number | null }): string | null {
  if (key.limit === undefined && key.limitRemaining === undefined) return null;
  if (key.limit == null) return 'No limit on this key';
  const money = (value: number) => `$${value.toFixed(2)}`;
  return key.limitRemaining == null ? `${money(key.limit)} limit` : `${money(key.limitRemaining)} of ${money(key.limit)} left`;
}
