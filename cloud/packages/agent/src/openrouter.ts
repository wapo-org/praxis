import {CapabilitiesSchema, type Capabilities} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';
import type {ModelProvider, ProviderRequest, ProviderEvent} from './types.js';
import {ProviderFailure, classifyProviderError} from './provider-error.js';
import {buildProviderRequest, object} from './wire.js';
import {decodeOpenAIChat, errorMessage, parseSSE} from './streams.js';

/** The only model endpoint. A constant: never taken from user input or stored configuration. */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
/** Where a user starts the PKCE connect flow. */
export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
/** OpenRouter app attribution: the user's activity lists requests under this name. */
export const OPENROUTER_APP_TITLE = 'Praxis';
const STREAM_MAX_BYTES = 16_000_000;
const STREAM_EVENT_MAX_BYTES = 1_000_000;
const ERROR_BODY_MAX_BYTES = 64_000;

export interface OpenRouterConfig {
  /** The user's own key, unsealed for this run only. */
  apiKey: SealedSecret;
  /** From the model's catalogue entry. */
  capabilities: Capabilities;
  maxStreamBytes?: number;
  maxEventBytes?: number;
}

export async function readBounded(response: Response, max = 4_000_000): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let total = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new ProviderFailure('fatal', 'Provider body exceeds buffer limit');
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Removes the key (and any bearer token) from text that may reach a client, a log or a trace. */
export function redactKey(text: string, apiKey?: SealedSecret): string {
  const key = apiKey?.reveal();
  if (key) text = text.split(key).join('[redacted]');
  return text
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .slice(0, 4000);
}

/** OpenRouter streaming chat completions with the user's key. `fetcher` is the guarded fetch in production. */
export function createOpenRouterProvider(config: OpenRouterConfig, fetcher: typeof fetch = fetch): ModelProvider {
  const capabilities = CapabilitiesSchema.parse(config.capabilities);
  const limits = {
    maxBytes: config.maxStreamBytes ?? STREAM_MAX_BYTES,
    maxEventBytes: config.maxEventBytes ?? STREAM_EVENT_MAX_BYTES,
  };
  const redact = (text: string) => redactKey(text, config.apiKey);
  return {
    capabilities,
    async *stream(input: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
      if (!config.apiKey.reveal()) throw new ProviderFailure('keyInvalid', 'No OpenRouter key is connected');
      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${config.apiKey.reveal()}`,
        'x-title': OPENROUTER_APP_TITLE,
      };
      let response: Response;
      try {
        response = await fetcher(`${OPENROUTER_API_BASE}/chat/completions`, {
          method: 'POST', headers, body: JSON.stringify(buildProviderRequest(input)), signal, redirect: 'error',
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ProviderFailure('unavailable', 'OpenRouter could not be reached', {cause: error});
      }
      if (!response.ok) {
        const text = await readBounded(response, ERROR_BODY_MAX_BYTES).catch(() => '');
        const message = redact(errorMessage(object(parseJson(text).error), text || `OpenRouter HTTP ${response.status}`));
        throw classifyProviderError(response.status, message, response.headers);
      }
      if (!response.body) throw new ProviderFailure('unavailable', 'OpenRouter returned an empty stream');
      try {
        yield* decodeOpenAIChat(parseSSE(response.body, signal, limits));
      } catch (error) {
        if (error instanceof ProviderFailure) throw error.withMessage(redact(error.message));
        if (signal.aborted) throw error;
        throw new ProviderFailure('unavailable', 'OpenRouter sent malformed stream data', {cause: error});
      }
    },
  };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text));
  } catch {
    return {};
  }
}
