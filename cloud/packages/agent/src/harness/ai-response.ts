import {z} from 'zod';
import {APICallError, type LanguageModelV4, type LanguageModelV4GenerateResult} from '@ai-sdk/provider';
import {RetryError} from 'ai';
import {DOCUMENT_BYTES_MAX, JsonObjectSchema, JsonValueSchema, UsageSchema, jsonBytes, type JsonObject, type MessagePart, type Usage} from '@praxis/protocol';
import {ProviderFailure, classifyProviderError} from '../provider-error.js';
import type {ProviderResponse} from '../types.js';


const MetadataSchema = z.record(z.string(), JsonObjectSchema);
const ContentSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('text'), text: z.string(), providerMetadata: MetadataSchema.optional()}),
  z.object({type: z.literal('reasoning'), text: z.string(), providerMetadata: MetadataSchema.optional()}),
  z.object({
    type: z.literal('tool-call'), toolCallId: z.string(), toolName: z.string(), input: z.string(),
    providerExecuted: z.boolean().optional(), providerMetadata: MetadataSchema.optional(),
  }),
]);
const Count = z.number().nonnegative().optional();
/** The JSON part of one `LanguageModelV4GenerateResult`: what a retried attempt replays instead of paying twice. */
export const SavedResponseSchema = z.object({
  content: z.array(ContentSchema),
  finishReason: z.object({
    unified: z.enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'interrupted', 'other']),
    raw: z.string().optional(),
  }),
  usage: z.object({
    inputTokens: z.object({total: Count, noCache: Count, cacheRead: Count, cacheWrite: Count}),
    outputTokens: z.object({total: Count, text: Count, reasoning: Count}),
  }),
  providerMetadata: MetadataSchema.optional(),
});
export type SavedResponse = z.infer<typeof SavedResponseSchema>;

/** Thrown inside the model call when the run left this turn, so nothing is saved or dispatched. */
export class InactiveTurn extends Error {
  constructor() {
    super('The run left this turn');
    this.name = 'InactiveTurn';
  }
}

/** Fails closed on output the stored chat cannot represent (generated files, provider-executed tools). */
export function savedResponse(result: LanguageModelV4GenerateResult): SavedResponse {
  const unsupported = result.content.find(part => !['text', 'reasoning', 'tool-call'].includes(part.type));
  if (unsupported) throw new ProviderFailure('fatal', `The model returned unsupported ${unsupported.type} output`);
  const json = JSON.parse(JSON.stringify({
    content: result.content, finishReason: result.finishReason,
    usage: {inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens},
    ...(result.providerMetadata ? {providerMetadata: result.providerMetadata} : {}),
  }));
  const saved = SavedResponseSchema.parse(json);
  if (jsonBytes(saved) > DOCUMENT_BYTES_MAX) {
    throw new ProviderFailure('context', 'The model response is too large to keep durably');
  }
  return saved;
}

export interface ResponseSlot {
  /** The response the last model call produced or replayed. */
  response?: SavedResponse;
}

export interface ResponseLedger {
  saveResponse(response: SavedResponse): Promise<void>;
  active(): Promise<boolean>;
}

/** Wraps the provider so the first response is saved before any tool runs and a retried attempt replays it. */
export function ledgerModel(
  model: LanguageModelV4, ledger: ResponseLedger, prior: SavedResponse | undefined, slot: ResponseSlot,
): LanguageModelV4 {
  const fresh = async (options: Parameters<LanguageModelV4['doGenerate']>[0]): Promise<SavedResponse> => {
    const saved = savedResponse(await model.doGenerate(options));
    if (!await ledger.active()) throw new InactiveTurn();
    await ledger.saveResponse(saved);
    return saved;
  };
  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const saved = prior ?? await fresh(options);
      slot.response = saved;
      return {...structuredClone(saved), warnings: []} as LanguageModelV4GenerateResult;
    },
    async doStream() {
      throw new Error('The turn harness generates one response; live deltas are PRA-9');
    },
  };
}

function openRouterMetadata(saved: SavedResponse): JsonObject {
  return saved.providerMetadata?.openrouter ?? {};
}

function costOf(saved: SavedResponse): number | undefined {
  const usage = openRouterMetadata(saved).usage;
  const cost = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage.cost : undefined;
  return typeof cost === 'number' && cost >= 0 ? cost : undefined;
}

function usageOf(saved: SavedResponse): Usage {
  const {inputTokens, outputTokens} = saved.usage;
  const cost = costOf(saved);
  return UsageSchema.parse({
    type: 'usage', inputTokens: inputTokens.total ?? 0, outputTokens: outputTokens.total ?? 0,
    cacheReadTokens: inputTokens.cacheRead ?? 0, cacheWriteTokens: inputTokens.cacheWrite ?? 0,
    ...(cost === undefined ? {} : {cost}),
  });
}

function signatureOf(part: SavedResponse['content'][number]): string | undefined {
  const details = part.providerMetadata?.openrouter?.reasoning_details;
  const first = Array.isArray(details) ? details[0] : undefined;
  const signature = first && typeof first === 'object' && !Array.isArray(first) ? first.signature : undefined;
  return typeof signature === 'string' ? signature : undefined;
}

function partOf(part: SavedResponse['content'][number]): MessagePart {
  switch (part.type) {
    case 'text': return {type: 'text', text: part.text};
    case 'reasoning': {
      const signature = signatureOf(part);
      return {type: 'reasoning', text: part.text, ...(signature ? {signature} : {})};
    }
    case 'tool-call': return {type: 'toolCall', callId: part.toolCallId, name: part.toolName, arguments: part.input};
  }
}

/** Only what the stored parts cannot rebuild: `reasoning_details` (signatures, encrypted) replay to OpenRouter as sent. */
function rawOf(saved: SavedResponse): ProviderResponse['raw'] {
  const details = openRouterMetadata(saved).reasoning_details;
  if (!Array.isArray(details) || !details.length) return undefined;
  return {type: 'provider.payload', data: JsonValueSchema.parse({role: 'assistant', reasoning_details: details})};
}

const STOP: Record<SavedResponse['finishReason']['unified'], ProviderResponse['stop']> = {
  'stop': 'endTurn', 'length': 'maxTokens', 'content-filter': 'refusal', 'tool-calls': 'toolUse',
  'error': 'endTurn', 'interrupted': 'pauseTurn', 'other': 'endTurn',
};

/** The saved model output in the stored-message vocabulary the commit and the next request share. */
export function providerResponse(saved: SavedResponse): ProviderResponse {
  const parts = saved.content.map(partOf);
  const raw = rawOf(saved);
  return {parts, stop: STOP[saved.finishReason.unified], usage: usageOf(saved), ...(raw ? {raw} : {})};
}

/** The AI SDK wraps exhausted retries; the last HTTP failure decides the kind, as the legacy client did. */
export function providerFailureOf(error: unknown): ProviderFailure | undefined {
  if (error instanceof ProviderFailure) return error;
  const last = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(last) || last.statusCode === undefined) return undefined;
  return classifyProviderError(last.statusCode, last.message, last.responseHeaders);
}
