import {OPENROUTER_API_BASE, readBounded, redactKey} from '@praxis/agent';
import type {JsonObject} from '@praxis/protocol';

/**
 * The few OpenRouter calls besides chat: key info, PKCE code exchange, the model list.
 * Every URL is built from the pinned base. `fetcher` is the guarded fetch in production.
 */
export class OpenRouterError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
  /** OpenRouter answered and said no (bad key, bad code), as opposed to being unreachable or failing. */
  get rejected() { return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429; }
}

export interface KeyInfo {label?: string; limit: number | null; limitRemaining: number | null}

const TIMEOUT_MS = 15_000;
const asObject = (value: unknown): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {});

async function call(fetcher: typeof fetch, path: string, init: RequestInit, secret = ''): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetcher(`${OPENROUTER_API_BASE}${path}`, {...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS)});
  } catch {
    throw new OpenRouterError(0, 'OpenRouter could not be reached');
  }
  const text = await readBounded(response, 8_000_000).catch(() => '');
  let json: JsonObject = {};
  try { json = asObject(JSON.parse(text)); } catch { /* not JSON: handled below */ }
  if (!response.ok) {
    const error = asObject(json.error);
    const message = typeof error.message === 'string' && error.message ? error.message : `OpenRouter answered ${response.status}`;
    throw new OpenRouterError(response.status, redactKey(message, secret).slice(0, 500));
  }
  return json;
}

const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** `GET /key`: label, credit limit and remaining credit of the key itself. */
export async function fetchKeyInfo(fetcher: typeof fetch, apiKey: string): Promise<KeyInfo> {
  const data = asObject((await call(fetcher, '/key', {method: 'GET', headers: {authorization: `Bearer ${apiKey}`, accept: 'application/json'}}, apiKey)).data);
  return {
    ...(typeof data.label === 'string' && data.label ? {label: redactKey(data.label, apiKey).slice(0, 100)} : {}),
    limit: numberOrNull(data.limit),
    limitRemaining: numberOrNull(data.limit_remaining),
  };
}

/** `POST /auth/keys`: trades a single-use PKCE code and its verifier for a user-controlled key. */
export async function exchangeCode(fetcher: typeof fetch, code: string, codeVerifier: string): Promise<string> {
  const json = await call(fetcher, '/auth/keys', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json'},
    body: JSON.stringify({code, code_verifier: codeVerifier, code_challenge_method: 'S256'}),
  });
  if (typeof json.key !== 'string' || !json.key) throw new OpenRouterError(502, 'OpenRouter returned no key');
  return json.key;
}

/** `GET /models`: the public model list. Sent without any key: the catalogue is shared, never a user's spend. */
export async function fetchModels(fetcher: typeof fetch): Promise<unknown[]> {
  const json = await call(fetcher, '/models', {method: 'GET', headers: {accept: 'application/json'}});
  if (!Array.isArray(json.data)) throw new OpenRouterError(502, 'OpenRouter returned no model list');
  return json.data;
}
