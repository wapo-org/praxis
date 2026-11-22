import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import type {LanguageModelV4} from '@ai-sdk/provider';
import type {ProviderOptions} from '@ai-sdk/provider-utils';
import type {ReasoningEffort} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';

export interface OpenRouterTurnModel {
  model: LanguageModelV4;
  providerOptions?: ProviderOptions;
}

/** The user's own key, revealed only into this request's provider; usage accounting returns `usage.cost`. */
export function openRouterTurnModel(
  apiKey: SealedSecret, modelId: string, effort: ReasoningEffort | undefined, fetcher?: typeof fetch,
): OpenRouterTurnModel {
  const provider = createOpenRouter({apiKey: apiKey.reveal(), compatibility: 'strict', ...(fetcher ? {fetch: fetcher} : {})});
  const model = provider.chat(modelId, {usage: {include: true}});
  return {model, ...(effort ? {providerOptions: {openrouter: {reasoning: {effort}}}} : {})};
}
