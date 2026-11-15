import {createOpenRouterProvider, type ModelProvider} from '@praxis/agent';
import {
  DEFAULT_MODEL_ID, ModelPreferenceRecordSchema, RECOMMENDED_MODELS,
  type CatalogModel, type ModelListItem, type ModelPreferenceRecord,
} from '@praxis/protocol';
import {ApiError, type ApiService} from '../service.js';
import {ModelCatalog, capabilitiesOf} from './catalog.js';
import {ModelKeys} from './keys.js';

export {ModelCatalog, capabilitiesOf, parseCatalogModel, CATALOG_TTL_MS, CATALOG_RETRY_MS} from './catalog.js';
export {ModelKeys, MODEL_KEY_KIND, MODEL_KEY_ID, MODEL_KEY_RESOURCE, SEALED_FIELD, maskKey} from './keys.js';
export {OpenRouterError} from './client.js';

export const MODEL_PREFERENCE_KIND = 'modelPreference';

/** dev:local only: the deterministic scripted models, listed beside the catalogue so local work needs no key. */
export const SCRIPTED_MODELS: CatalogModel[] = [['scripted', 'Praxis Scripted'], ['scripted-vision', 'Praxis Vision']].map(([id, name]) => ({
  type: 'catalogModel' as const, id: id!, name: name!, contextLength: 128_000, maxOutput: 8192,
  pricing: {prompt: '0', completion: '0'}, capabilities: {tools: true, reasoning: true, images: true, files: true},
}));
export const isScripted = (modelId: string | undefined) => !!modelId && SCRIPTED_MODELS.some(m => m.id === modelId);

export interface RunModel {provider: ModelProvider; model: CatalogModel; note?: string}

/** OpenRouter with the user's own key: the only way a model is reached. */
export class OpenRouterModels {
  readonly keys: ModelKeys;
  readonly catalog: ModelCatalog;

  constructor(private service: ApiService, encryptionKey: string | undefined, private fetcher: typeof fetch = fetch, clock: () => number = Date.now) {
    this.keys = new ModelKeys(service, encryptionKey, fetcher);
    this.catalog = new ModelCatalog(service.adapters.kv, fetcher, clock);
  }

  /** Catalogue entries a client may list; local dev includes scripted models. */
  async models(): Promise<CatalogModel[]> {
    if (!this.service.local) return this.catalog.list();
    const remote = await this.catalog.list().catch(error => {
      if (error instanceof ApiError && error.code === 'catalog_unavailable') return [];
      throw error;
    });
    return [...SCRIPTED_MODELS, ...remote];
  }

  async preferences(userId: string): Promise<Map<string, ModelPreferenceRecord>> {
    const rows = await this.service.list<unknown>(userId, MODEL_PREFERENCE_KIND);
    return new Map(rows.flatMap(row => { const p = ModelPreferenceRecordSchema.safeParse(row); return p.success ? [[p.data.modelId, p.data] as const] : []; }));
  }

  /** The catalogue for one user: pinned first, then the curated list in its order, then by name. */
  async list(userId: string): Promise<ModelListItem[]> {
    const [models, preferences] = await Promise.all([this.models(), this.preferences(userId)]);
    const rank = (id: string) => { const i = (RECOMMENDED_MODELS as readonly string[]).indexOf(id); return i < 0 ? RECOMMENDED_MODELS.length : i; };
    return models
      .map(m => ({...m, pinned: preferences.get(m.id)?.pinned ?? false, favorite: preferences.get(m.id)?.favorite ?? false, recommended: rank(m.id) < RECOMMENDED_MODELS.length}))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || rank(a.id) - rank(b.id) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async setPreference(userId: string, modelId: string, change: {pinned?: boolean | undefined; favorite?: boolean | undefined}): Promise<ModelPreferenceRecord> {
    const current = (await this.preferences(userId)).get(modelId);
    // A model that left the catalogue can still be unpinned; a new preference needs a real entry.
    if (!current && !(await this.models()).some(m => m.id === modelId)) throw new ApiError(404, 'not_found', 'Model not found');
    const next: ModelPreferenceRecord = {type: 'modelPreference', modelId, pinned: change.pinned ?? current?.pinned ?? false, favorite: change.favorite ?? current?.favorite ?? false};
    if (next.pinned || next.favorite) await this.service.write(userId, MODEL_PREFERENCE_KIND, modelId, next);
    else if (current) await this.service.remove(userId, MODEL_PREFERENCE_KIND, modelId);
    return next;
  }

  /** Resolves run model and ephemeral user-key provider; falls back to default with note. */
  async forRun(userId: string, requestedId: string | undefined): Promise<RunModel> {
    const apiKey = await this.keys.reveal(userId);
    const wanted = requestedId ?? DEFAULT_MODEL_ID;
    let model = await this.catalog.find(wanted), note: string | undefined;
    if (!model) {
      model = await this.catalog.find(DEFAULT_MODEL_ID);
      if (!model) throw new ApiError(503, 'model_unavailable', `${wanted} is not available on OpenRouter, and neither is the default model. Choose another model.`);
      note = `${wanted} is no longer available on OpenRouter. This turn used ${model.name} instead.`;
    }
    return {model, provider: createOpenRouterProvider({apiKey, capabilities: capabilitiesOf(model)}, this.fetcher), ...(note ? {note} : {})};
  }

  /** A provider for an auxiliary model (the image reader), or null when it can't be used: no key, or not listed. */
  async auxiliary(userId: string, modelId: string): Promise<ModelProvider | null> {
    const key = await this.keys.get(userId);
    if (!key) return null;
    const model = await this.catalog.find(modelId);
    if (!model) return null;
    return createOpenRouterProvider({apiKey: await this.keys.reveal(userId), capabilities: capabilitiesOf(model)}, this.fetcher);
  }
}
