/**
 * WP-PRA59 Phase A bridge. The server and protocol no longer have providers or per-user model rows
 * (OpenRouter with the user's own key is the only provider). The web screens that still use these
 * shapes are replaced in Phase B, which deletes this file. Nothing new may import it.
 */
import { z } from "zod";
import {
  CapabilitiesSchema,
  IdSchema,
  TimestampSchema,
  type Bootstrap,
} from "@praxis/protocol";

const ProviderFlavorSchema = z.enum([
  "anthropicMessages",
  "openAIChat",
  "openAIResponses",
]);
const ProviderRequestOptionsSchema = z.object({
  type: z
    .literal("provider.request-options")
    .default("provider.request-options"),
  systemRole: z.enum(["system", "developer"]).optional(),
  maxTokensField: z
    .enum(["max_tokens", "max_completion_tokens", "omit"])
    .optional(),
  replayReasoning: z.boolean().optional(),
});
export const ProviderSchema = z.object({
  type: z.literal("provider"),
  id: IdSchema,
  name: z.string(),
  flavor: ProviderFlavorSchema,
  baseUrl: z.string().url(),
  maskedKey: z.string(),
  capabilities: CapabilitiesSchema,
  updatedAt: TimestampSchema,
  defaultModel: z.string().optional(),
  requestOptions: ProviderRequestOptionsSchema.optional(),
  headerNames: z.array(z.string()).optional(),
});
export type Provider = z.infer<typeof ProviderSchema>;
export const ModelSchema = z.object({
  type: z.literal("model"),
  id: IdSchema,
  providerId: IdSchema,
  displayName: z.string(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  tagline: z.string().optional(),
  speed: z.number().int().min(1).max(5).optional(),
  intelligence: z.number().int().min(1).max(5).optional(),
  supportsImages: z.boolean().nullable().optional(),
  capabilities: CapabilitiesSchema,
  reasoningEfforts: z.array(z.string()),
  pinned: z.boolean(),
  favorite: z.boolean(),
});
export type Model = z.infer<typeof ModelSchema>;
const ProviderProbeSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  streaming: z.boolean(),
  reasoningEfforts: z.array(z.string()),
});
const ProviderProbeErrorSchema = z.object({
  code: z.enum([
    "timeout",
    "provider_unavailable",
    "provider_error",
    "unreachable",
  ]),
  message: z.string().max(500),
});
export const ProviderTestResultSchema = z.object({
  type: z.literal("provider.test.result"),
  ok: z.boolean(),
  models: z.array(ModelSchema),
  probe: ProviderProbeSchema.optional(),
  error: ProviderProbeErrorSchema.optional(),
  message: z.string().optional(),
});
/** The bootstrap as the Phase A web still reads it. The server no longer sends these two lists; the client fills them in empty. */
export type LegacyBootstrap = Bootstrap & { providers: Provider[]; models: Model[] };
