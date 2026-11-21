import {SealedSecret} from '@praxis/types';
import {z} from 'zod';
import {classifyProviderError, ProviderFailure} from '../provider-error.js';

const responseSchema = z.object({
  data: z.array(z.object({embedding: z.array(z.number().finite())})),
  error: z.object({message: z.string()}).optional(),
});

export interface EmbeddedQuery {
  text: string;
  images?: string[];
}

export interface EmbeddedQueryResult {
  embedding: number[];
  imagesDropped: boolean;
}

export async function embedTexts(
  key: SealedSecret,
  model: string,
  dimensions: number,
  inputs: string[],
  fetcher: typeof fetch = fetch,
): Promise<number[][]> {
  const response = await request(key, model, dimensions, inputs, fetcher);
  if (!response.ok) throw await failure(response);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.data.length !== inputs.length) {
    throw new ProviderFailure('fatal', 'Embedding provider returned an invalid response');
  }
  return parsed.data.data.map(({embedding}) => normalizeEmbedding(embedding, dimensions));
}

export async function embedQuery(
  key: SealedSecret,
  model: string,
  dimensions: number,
  input: EmbeddedQuery,
  fetcher: typeof fetch = fetch,
): Promise<EmbeddedQueryResult> {
  const content = input.images?.length
    ? [{type: 'text', text: input.text}, ...input.images.map(image => ({type: 'image_url', image_url: {url: image}}))]
    : input.text;
  const response = await request(key, model, dimensions, [content], fetcher);
  if (!response.ok && input.images?.length) {
    const retry = await request(key, model, dimensions, [input.text], fetcher);
    if (!retry.ok) throw await failure(retry);
    return {embedding: readSingleEmbedding(await retry.json(), dimensions), imagesDropped: true};
  }
  if (!response.ok) throw await failure(response);
  return {embedding: readSingleEmbedding(await response.json(), dimensions), imagesDropped: false};
}

export function fakeEmbedder(dimensions: number): (inputs: string[]) => number[][] {
  return inputs => inputs.map(input => {
    const vector = Array.from({length: dimensions}, (_, index) => Math.sin(hash(input) + index));
    return normalizeEmbedding(vector, dimensions);
  });
}

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

function normalizeEmbedding(values: number[], dimensions: number): number[] {
  if (values.length < dimensions) throw new ProviderFailure('fatal', 'Embedding provider returned too few dimensions');
  const truncated = values.slice(0, dimensions);
  const magnitude = Math.sqrt(truncated.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) throw new ProviderFailure('fatal', 'Embedding provider returned a zero vector');
  return truncated.map(value => value / magnitude);
}

function readSingleEmbedding(value: unknown, dimensions: number): number[] {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success || parsed.data.data.length !== 1) {
    throw new ProviderFailure('fatal', 'Embedding provider returned an invalid response');
  }
  const first = parsed.data.data[0];
  if (!first) throw new ProviderFailure('fatal', 'Embedding provider returned an invalid response');
  return normalizeEmbedding(first.embedding, dimensions);
}

async function request(key: SealedSecret, model: string, dimensions: number, input: unknown[], fetcher: typeof fetch): Promise<Response> {
  try {
    return await fetcher('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {Authorization: `Bearer ${key.reveal()}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model, input, dimensions, encoding_format: 'float'}),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new ProviderFailure('unavailable', 'Embedding provider is unavailable', {cause: error});
  }
}

async function failure(response: Response): Promise<ProviderFailure> {
  const body = await response.json().catch(() => undefined);
  const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'message' in body.error && typeof body.error.message === 'string'
    ? body.error.message
    : 'Embedding provider request failed';
  return classifyProviderError(response.status, message, response.headers);
}
