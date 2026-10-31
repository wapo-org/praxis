import type {AgentCheckpoint} from '@praxis/agent';
import type {JsonObject, Model} from '@praxis/protocol';
import type {ApiService} from './service.js';

/** Learned provider rejections lapse after this (ProviderSettings image/tool/effort rejection lifetimes). */
export const LEARNED_LIFETIME_MS = 14 * 24 * 3600 * 1000;
interface Learning {images?: number; tools?: number; efforts?: {levels: string[]; at: number}}

const freshAt = (now: number) => (t?: number) => t !== undefined && now - t < LEARNED_LIFETIME_MS;

export async function learnedFor(service: ApiService, userId: string, providerId: string, modelId: string, now: number) {
  const row = await service.adapters.store.get(userId, 'modelLearning', `${providerId}:${modelId}`);
  const l = (row && !row.deleted ? row.value : {}) as Learning;
  const fresh = freshAt(now);
  return {images: fresh(l.images), tools: fresh(l.tools), efforts: l.efforts && fresh(l.efforts.at) ? l.efforts.levels : undefined};
}

/**
 * Persists what a run learned (provider refused images/tools/effort levels), so the next turn doesn't fail once more.
 * A lapsed observation counts as absent, so a provider that still refuses after the lifetime is learned again.
 */
export async function recordLearning(service: ApiService, userId: string, cp: AgentCheckpoint, now: number) {
  const providerId = cp.chat.providerId;
  if (!providerId || providerId === 'scripted') return;
  const modelRow = await service.adapters.store.get(userId, 'model', `${providerId}:${cp.modelId}`);
  if (!modelRow || modelRow.deleted) return;
  const model = modelRow.value as unknown as Model;
  const key = `${providerId}:${cp.modelId}`;
  const row = await service.adapters.store.get(userId, 'modelLearning', key);
  const current = (row && !row.deleted ? row.value : {}) as Learning;
  const fresh = freshAt(now);
  const next: Learning = {...current};
  if (model.capabilities.vision && !cp.capabilities.vision && !fresh(current.images)) next.images = now;
  if (model.capabilities.tools && !cp.capabilities.tools && !fresh(current.tools)) next.tools = now;
  const levels = cp.supportedEfforts && JSON.stringify(cp.supportedEfforts);
  const known = current.efforts && fresh(current.efforts.at) ? JSON.stringify(current.efforts.levels) : undefined;
  if (cp.supportedEfforts && levels !== JSON.stringify(model.reasoningEfforts) && levels !== known) next.efforts = {levels: cp.supportedEfforts, at: now};
  if (JSON.stringify(next) !== JSON.stringify(current)) await service.adapters.store.put(userId, 'modelLearning', key, next as unknown as JsonObject);
}
