/**
 * Text embedders for semantic search. Every embedder returns unit-length vectors of EMBEDDING_DIMENSIONS, so
 * cosine similarity is a dot product and one Convex vector index (fixed dimensions) serves all of them.
 *
 * - `minilm`: all-MiniLM-L6-v2 (q8, 24 MB, Apache-2.0) on the server through transformers.js. No key, no paid
 *   service; the weights are fetched once from the Hugging Face hub into a local cache, then it runs offline.
 *   The dependency is dev-only and loaded dynamically, so a bundle without it falls back.
 * - `openai`: text-embedding-3-small at 384 dimensions. Only when the operator sets PRAXIS_OPENAI_EMBEDDINGS_KEY
 *   (a paid API: never enabled by default).
 * - `hash`: offline and deterministic: stemmed words and their trigrams hashed into the vector. Lexical-fuzzy,
 *   not semantic; the fallback when no model can load.
 */
export const EMBEDDING_DIMENSIONS = 384;

export interface Embedder {
  /** Stable id: vectors from different embedders are never compared. */
  readonly id: string;
  /** Cosine at or above which a hit counts as related on its own (calibrated per embedder). */
  readonly threshold: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

const STOP = new Set(
  'a an and are as at be by can do does for from how i in is it me my of on or so that the this to was what when where which who why will with you your'.split(' '),
);

/** Lower-case words, stop words dropped, a light English stem (packing → pack, lists → list). */
export function terms(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(w => !STOP.has(w))
    .map(w => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const hashEmbedder: Embedder = {
  id: 'hash-v1',
  threshold: 0.35,
  async embed(texts) {
    return texts.map(text => {
      const v = new Float32Array(EMBEDDING_DIMENSIONS);
      const add = (feature: string, weight: number) => {
        const h = fnv(feature);
        v[h % EMBEDDING_DIMENSIONS]! += (h & 0x80000000 ? -1 : 1) * weight;
      };
      for (const w of terms(text)) {
        add('w:' + w, 1);
        for (let i = 0; i + 3 <= w.length; i++) add('g:' + w.slice(i, i + 3), 0.25);
      }
      return normalize(v);
    });
  },
};

type FeatureExtractor = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

/** all-MiniLM-L6-v2 through transformers.js; resolves to null when the package or the weights are unavailable. */
export async function loadMiniLmEmbedder(cacheDir = `${process.env.HOME ?? '.'}/.cache/praxis-embeddings`): Promise<Embedder | null> {
  try {
    const name = '@huggingface/transformers';
    const mod = (await import(/* @vite-ignore */ name)) as {
      pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<FeatureExtractor>;
      env: { cacheDir: string };
    };
    mod.env.cacheDir = cacheDir;
    const extract = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    return {
      id: 'minilm-l6-v2-q8',
      threshold: 0.3,
      async embed(texts) {
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += 32) {
          const batch = texts.slice(i, i + 32);
          const result = await extract(batch, { pooling: 'mean', normalize: true });
          for (let j = 0; j < batch.length; j++) out.push(result.data.slice(j * EMBEDDING_DIMENSIONS, (j + 1) * EMBEDDING_DIMENSIONS));
        }
        return out;
      },
    };
  } catch (error) {
    console.warn(`[praxis-search] MiniLM unavailable, using the offline hash embedder: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
    return null;
  }
}

/** OpenAI text-embedding-3-small at 384 dimensions. Paid; only built when the operator supplies a key. */
export function openAiEmbedder(apiKey: string, fetcher: typeof fetch = fetch): Embedder {
  return {
    id: 'openai-3-small-384',
    threshold: 0.3,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 128) {
        const res = await fetcher('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'text-embedding-3-small', dimensions: EMBEDDING_DIMENSIONS, input: texts.slice(i, i + 128) }),
        });
        if (!res.ok) throw new Error(`Embedding request failed: ${res.status}`);
        const body = (await res.json()) as { data: { embedding: number[] }[] };
        for (const row of body.data) out.push(normalize(Float32Array.from(row.embedding)));
      }
      return out;
    },
  };
}

/** MiniLM loaded on first use (production, where startup is synchronous). Fails per call when unavailable. */
export function lazyMiniLmEmbedder(cacheDir?: string): Embedder {
  let loaded: Promise<Embedder | null> | undefined;
  return {
    id: 'minilm-l6-v2-q8',
    threshold: 0.3,
    async embed(texts) {
      const model = await (loaded ??= loadMiniLmEmbedder(cacheDir));
      if (!model) throw new Error('MiniLM is not available in this deployment');
      return model.embed(texts);
    },
  };
}

/** Production: PRAXIS_EMBEDDER = openai | minilm | hash | none (default none, unless an embeddings key is set). */
export function productionEmbedder(env: Record<string, string | undefined>): Embedder | null {
  const choice = env.PRAXIS_EMBEDDER ?? (env.PRAXIS_OPENAI_EMBEDDINGS_KEY ? 'openai' : 'none');
  if (choice === 'none') return null;
  if (choice === 'hash') return hashEmbedder;
  if (choice === 'minilm') return lazyMiniLmEmbedder(env.PRAXIS_EMBEDDINGS_CACHE);
  if (choice === 'openai') {
    if (!env.PRAXIS_OPENAI_EMBEDDINGS_KEY) throw new Error('PRAXIS_EMBEDDER=openai needs PRAXIS_OPENAI_EMBEDDINGS_KEY');
    return openAiEmbedder(env.PRAXIS_OPENAI_EMBEDDINGS_KEY);
  }
  throw new Error(`Unknown PRAXIS_EMBEDDER: ${choice}`);
}

/** PRAXIS_EMBEDDER = minilm | openai | hash | none. Defaults: minilm (falling back to hash) locally, none in production. */
export async function selectEmbedder(env: Record<string, string | undefined>, local: boolean): Promise<Embedder | null> {
  const choice = env.PRAXIS_EMBEDDER ?? (local ? 'minilm' : env.PRAXIS_OPENAI_EMBEDDINGS_KEY ? 'openai' : 'none');
  if (choice === 'none') return null;
  if (choice === 'hash') return hashEmbedder;
  if (choice === 'openai') {
    if (!env.PRAXIS_OPENAI_EMBEDDINGS_KEY) throw new Error('PRAXIS_EMBEDDER=openai needs PRAXIS_OPENAI_EMBEDDINGS_KEY');
    return openAiEmbedder(env.PRAXIS_OPENAI_EMBEDDINGS_KEY);
  }
  if (choice === 'minilm') return (await loadMiniLmEmbedder(env.PRAXIS_EMBEDDINGS_CACHE)) ?? hashEmbedder;
  throw new Error(`Unknown PRAXIS_EMBEDDER: ${choice}`);
}
