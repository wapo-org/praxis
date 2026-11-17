import {
  CapabilitiesSchema, CatalogModelSchema, REASONING_EFFORTS,
  type Capabilities, type CatalogModel, type ReasoningEffort,
} from '@praxis/protocol';
import type {KV} from '../contracts.js';
import {ApiError} from '../service.js';
import {fetchModels} from './client.js';

export const CATALOG_TTL_MS = 3_600_000;
/** After a failed refresh the last good copy is served for this long before OpenRouter is asked again. */
export const CATALOG_RETRY_MS = 60_000;
const KV_KEY = 'openrouter:catalog';

interface Snapshot {fetchedAt: number; models: CatalogModel[]}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const positiveInt = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined);
const price = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '0');

/** Maps one OpenRouter entry to a catalogue entry, or null if non-chat. */
export function parseCatalogModel(raw: unknown): CatalogModel | null {
  const m = record(raw), architecture = record(m.architecture), top = record(m.top_provider), pricing = record(m.pricing);
  const contextLength = positiveInt(m.context_length) ?? positiveInt(top.context_length);
  const outputs = strings(architecture.output_modalities);
  if (typeof m.id !== 'string' || !m.id || m.id.length > 200 || !contextLength || (outputs.length > 0 && !outputs.includes('text'))) return null;
  const parameters = strings(m.supported_parameters), maxOutput = positiveInt(top.max_completion_tokens);
  const parsed = CatalogModelSchema.safeParse({
    type: 'catalogModel',
    id: m.id,
    name: typeof m.name === 'string' && m.name ? m.name : m.id,
    contextLength,
    ...(record(m.reasoning).mandatory === true ? {reasoningMandatory: true} : {}),
    ...(maxOutput ? {maxOutput} : {}),
    pricing: {prompt: price(pricing.prompt), completion: price(pricing.completion)},
    capabilities: {
      tools: parameters.includes('tools'),
      reasoning: parameters.includes('reasoning'),
      images: strings(architecture.input_modalities).includes('image'),
      files: strings(architecture.input_modalities).includes('file'),
    },
  });
  return parsed.success ? parsed.data : null;
}

/** What the run loop may send to a model, taken from its catalogue entry alone. */
export function capabilitiesOf(model: CatalogModel): Capabilities {
  return CapabilitiesSchema.parse({
    tools: model.capabilities.tools,
    parallelToolCalls: model.capabilities.tools,
    vision: model.capabilities.images,
    documents: model.capabilities.files,
    reasoningEffort: model.capabilities.reasoning,
    streamUsage: true,
  });
}

/** Client effort names, including ones beyond what OpenRouter's unified `reasoning.effort` takes, in ascending order. */
const EFFORT_SCALE = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The effort sent for this model: none unless its entry takes reasoning; other names clamp to the nearest offered level. */
export function resolveEffort(model: CatalogModel, wanted: string | undefined): ReasoningEffort | undefined {
  if (!model.capabilities.reasoning || !wanted) return undefined;
  const rank = (EFFORT_SCALE as readonly string[]).indexOf(wanted.toLowerCase());
  if (rank <= 0) return undefined;
  const offered = REASONING_EFFORTS.map(effort => ({effort, rank: EFFORT_SCALE.indexOf(effort)}));
  const nearest = offered.reduce((best, next) => (Math.abs(next.rank - rank) < Math.abs(best.rank - rank) ? next : best));
  return nearest.effort;
}

/** Shared 1h KV/memory model catalogue; serves stale snapshot if refresh fails. */
export class ModelCatalog {
  private memory: Snapshot | undefined;
  private retryAt = 0;
  private refreshing: Promise<Snapshot> | undefined;

  constructor(private kv: KV, private fetcher: typeof fetch = fetch, private clock: () => number = Date.now) {}

  async list(): Promise<CatalogModel[]> {
    const now = this.clock();
    const fresh = (s: Snapshot | undefined) => !!s && now - s.fetchedAt < CATALOG_TTL_MS;
    let known = this.memory;
    if (!fresh(known)) {
      // Another instance may have refreshed the shared copy.
      const shared = await this.kv.get<Snapshot>(KV_KEY).catch(() => null);
      if (shared && (!known || shared.fetchedAt > known.fetchedAt)) known = this.memory = shared;
    }
    if (known && (fresh(known) || now < this.retryAt)) return known.models;
    try {
      return (await (this.refreshing ??= this.refresh(now).finally(() => { this.refreshing = undefined; }))).models;
    } catch {
      this.retryAt = now + CATALOG_RETRY_MS;
      if (known) return known.models;
      throw new ApiError(503, 'catalog_unavailable', 'The model list could not be loaded from OpenRouter. Try again shortly.');
    }
  }

  async find(id: string): Promise<CatalogModel | undefined> {
    return (await this.list()).find(m => m.id === id);
  }

  private async refresh(now: number): Promise<Snapshot> {
    const models = (await fetchModels(this.fetcher)).map(parseCatalogModel).filter((m): m is CatalogModel => !!m);
    if (!models.length) throw new Error('OpenRouter returned an empty model list');
    const snapshot = {fetchedAt: now, models};
    this.memory = snapshot;
    // No TTL: the last good copy must outlive the hour so it can be served when a later refresh fails.
    await this.kv.set(KV_KEY, snapshot).catch(() => undefined);
    return snapshot;
  }
}
