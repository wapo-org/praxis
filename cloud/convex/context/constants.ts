// The provider model defines the vector space shared by all context items.
export const CONTEXT_EMBEDDING_MODEL = 'google/gemini-embedding-2';
// The vector index schema and embedding requests must use the same dimension.
export const CONTEXT_EMBEDDING_DIMENSIONS = 768;
// Shared context is visible to retrieval but never belongs to a user account.
export const CONTEXT_SHARED_OWNER = '@shared';
// Summaries are bounded before hashing and embedding.
export const CONTEXT_SUMMARY_MAX_CHARACTERS = 600;
// Each owner can index at most this many context items.
export const CONTEXT_ITEMS_PER_USER_MAX = 1_000;
// Embedding actions process a bounded number of rows per invocation.
export const CONTEXT_REEMBED_BATCH_MAX = 32;
// Failed embeddings stop retrying after this many attempts.
export const CONTEXT_EMBED_ATTEMPTS_MAX = 5;
// Provider calls must finish within this request budget.
export const CONTEXT_EMBED_TIMEOUT_MS = 5_000;

export function contextScopeKind(userId: string, kind: string): string {
  return `${userId}\u0000${CONTEXT_EMBEDDING_MODEL}:${CONTEXT_EMBEDDING_DIMENSIONS}\u0000${kind}`;
}
