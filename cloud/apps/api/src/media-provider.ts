import {rehydrateAttachments, withRequestTransforms, type AttachmentResolver, type ModelProvider} from '@praxis/agent';

export type ModelCapabilities = ModelProvider['capabilities'];

/** The legacy runner's provider-wrapping form of the harness's request-time attachment rehydration. */
export function withMedia(provider: ModelProvider, resolve: AttachmentResolver): ModelProvider {
  return withRequestTransforms(provider, [rehydrateAttachments(resolve)]);
}
