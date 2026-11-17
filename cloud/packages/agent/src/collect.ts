import {ProviderFailure} from './provider-error.js';
import {ProviderResponseSchema, type ModelProvider, type ProviderRequest, type ProviderResponse} from './types.js';

/** Drains a provider stream to its completed response; the stream is the only model wire format. */
export async function collectResponse(
  provider: ModelProvider,
  request: ProviderRequest,
  signal: AbortSignal,
): Promise<ProviderResponse> {
  for await (const event of provider.stream(request, signal)) {
    if (event.type === 'completed') return ProviderResponseSchema.parse(event.response);
  }
  throw new ProviderFailure('unavailable', 'Provider stream ended without a completed response');
}
