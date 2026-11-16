import {ModelKeySchema, type ModelKey, type ModelKeyConnectInput} from '@praxis/protocol';
import {SealedSecret} from '@praxis/types';
import {seal, unseal} from '../secrets.js';
import {ApiError, type ApiService} from '../service.js';
import {OpenRouterError, exchangeCode, fetchKeyInfo, type KeyInfo} from './client.js';

export const MODEL_KEY_KIND = 'modelKey';
export const MODEL_KEY_ID = 'current';
/** AES-GCM authenticated-data resource; with the owner id it binds the sealed key to one user. */
export const MODEL_KEY_RESOURCE = 'modelKey';
/** The row field holding the sealed key. `ModelKeySchema` does not know it, so parsing a row drops it. */
export const SEALED_FIELD = 'sealed';

export const maskKey = (key: SealedSecret) => `••••${key.reveal().slice(-4)}`;

const missing = () => new ApiError(400, 'model_key_missing', 'Connect your OpenRouter key to use models');

/** Per-user OpenRouter key sealed with owner AAD; never returned or logged. */
export class ModelKeys {
  constructor(private service: ApiService, private encryptionKey: string | undefined, private fetcher: typeof fetch = fetch) {}

  /** The masked record, or null when no key is connected. */
  async get(userId: string): Promise<ModelKey | null> {
    const row = await this.service.adapters.store.get(userId, MODEL_KEY_KIND, MODEL_KEY_ID);
    return row && !row.deleted ? ModelKeySchema.parse(row.value) : null;
  }

  async connect(userId: string, input: ModelKeyConnectInput): Promise<ModelKey> {
    let apiKey: SealedSecret, info: KeyInfo | undefined;
    if (input.method === 'pkce') {
      try {
        apiKey = await exchangeCode(this.fetcher, input.code, input.codeVerifier);
      } catch (error) {
        throw connectError(error, 'OpenRouter did not accept this sign-in. The code may have expired or been used already; connect again.');
      }
      // The exchange already proved the key; a failed info call must not lose it.
      info = await fetchKeyInfo(this.fetcher, apiKey).catch(() => undefined);
    } else {
      const pasted = input.apiKey.trim();
      if (!pasted.startsWith('sk-or-')) throw new ApiError(400, 'model_key_rejected', 'This is not an OpenRouter key. OpenRouter keys start with "sk-or-".');
      apiKey = SealedSecret.of(pasted);
      try {
        info = await fetchKeyInfo(this.fetcher, apiKey);
      } catch (error) {
        throw connectError(error, 'OpenRouter did not accept this key.');
      }
    }
    const record: ModelKey = {
      type: 'modelKey',
      maskedKey: maskKey(apiKey),
      connectedAt: this.service.now(),
      ...(info?.label ? {label: info.label} : {}),
      ...(info ? {limit: info.limit, limitRemaining: info.limitRemaining} : {}),
    };
    await this.save(userId, record, seal(apiKey.reveal(), userId, MODEL_KEY_RESOURCE, this.encryptionKey));
    return record;
  }

  /** Refreshes label, limit and remaining credit. A key OpenRouter no longer accepts is marked, not thrown. */
  async check(userId: string): Promise<ModelKey> {
    const apiKey = await this.reveal(userId);
    try {
      const info = await fetchKeyInfo(this.fetcher, apiKey);
      return this.update(userId, record => {
        const {lastError: _cleared, label: _label, ...rest} = record;
        return {...rest, ...(info.label ? {label: info.label} : {}), limit: info.limit, limitRemaining: info.limitRemaining};
      });
    } catch (error) {
      if (error instanceof OpenRouterError && (error.status === 401 || error.status === 403)) return this.markInvalid(userId, error.message);
      throw new ApiError(502, 'openrouter_unavailable', 'OpenRouter could not be reached. Try again shortly.');
    }
  }

  async remove(userId: string): Promise<void> {
    await this.service.remove(userId, MODEL_KEY_KIND, MODEL_KEY_ID);
  }

  /** The key itself, for one OpenRouter call on behalf of `userId`. Callers must not persist or log it. */
  async reveal(userId: string): Promise<SealedSecret> {
    const row = await this.service.adapters.store.get(userId, MODEL_KEY_KIND, MODEL_KEY_ID);
    const sealed = row && !row.deleted ? row.value[SEALED_FIELD] : undefined;
    if (typeof sealed !== 'string') throw missing();
    if (!this.encryptionKey) throw new ApiError(503, 'encryption_unconfigured', 'Secret storage is not configured');
    try {
      return SealedSecret.of(unseal(sealed, userId, MODEL_KEY_RESOURCE, this.encryptionKey));
    } catch {
      throw new ApiError(503, 'secret_unavailable', 'The OpenRouter key could not be read');
    }
  }

  /** Records that OpenRouter rejected the key (a 401 during a run or a check). */
  async markInvalid(userId: string, message: string): Promise<ModelKey> {
    return this.update(userId, record => ({...record, lastError: message.slice(0, 500) || 'OpenRouter rejected this key'}));
  }

  private async update(userId: string, change: (record: ModelKey) => ModelKey): Promise<ModelKey> {
    const row = await this.service.adapters.store.get(userId, MODEL_KEY_KIND, MODEL_KEY_ID);
    const sealed = row && !row.deleted ? row.value[SEALED_FIELD] : undefined;
    if (!row || typeof sealed !== 'string') throw missing();
    const next = ModelKeySchema.parse(change(ModelKeySchema.parse(row.value)));
    await this.save(userId, next, sealed);
    return next;
  }

  /** The row holds the sealed key; the change event and every response carry the masked record only. */
  private async save(userId: string, record: ModelKey, sealed: string) {
    await this.service.put(userId, MODEL_KEY_KIND, MODEL_KEY_ID, {...record, [SEALED_FIELD]: sealed});
    await this.service.changed(userId, MODEL_KEY_KIND, MODEL_KEY_ID, 'upsert', record);
  }
}

function connectError(error: unknown, rejected: string): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof OpenRouterError && error.rejected) return new ApiError(400, 'model_key_rejected', `${rejected} OpenRouter said: ${error.message}`);
  return new ApiError(502, 'openrouter_unavailable', 'OpenRouter could not be reached. Try again shortly.');
}
