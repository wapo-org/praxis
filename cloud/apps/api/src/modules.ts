import {cropImage, cropImageReaderTool} from './features/tools/image-crop.js';
import {connectorToolNotes} from './features/tools/tool-notes.js';
import {Hono} from 'hono';
import {createImageReaderTool, type AgentTool, type ModelProvider} from '@praxis/agent';
import {PreferencesSchema, type Chat, type MessagePart, type Model} from '@praxis/protocol';
import type {FeatureContext, FeatureTool} from './contracts.js';
import {createMcpRoutes, getMcpTools, type McpOptions} from './features/mcp/index.js';
import {createLocalToolsStorage, createToolsRoutes, type ToolsStorage} from './features/tools/index.js';
import {javascriptTool, listSkillsForCatalog, skillTools} from './features/tools/builtin.js';
import type {FeatureModule} from './server.js';
import type {ApiService} from './service.js';

export interface ModuleOptions {
  /** Attachment storage (Convex files in production). Local dev uses the in-process fixture. */
  storage?: ToolsStorage;
  mcp?: McpOptions;
}

/** MCP connectors + builtin tools (skills, JavaScript) + vision fallback, sharing one storage instance. */
export function featureModules(service: ApiService, options: ModuleOptions = {}): FeatureModule[] {
  const storage = options.storage;
  const mcp = options.mcp ?? {};
  return [
    {
      publicPaths: ['/v1/connectors/oauth/callback', '/v1/oauth/client-metadata.json'],
      routes: contextFor => {
        const app = new Hono();
        app.route('/', createMcpRoutes(contextFor, mcp));
        app.route('/', createToolsRoutes(contextFor, {...(storage ? {storage} : {})}));
        return app;
      },
      execution: {
        skills: ctx => listSkillsForCatalog(ctx),
        toolNotes: async (ctx, chat) => connectorToolNotes(await getMcpTools(ctx, {chatId: chat.id, disabledConnectorIds: chat.disabledConnectorIds}, mcp)),
        async tools(ctx, {chat, attachmentIds}) {
          const connectors = await getMcpTools(ctx, {chatId: chat.id, disabledConnectorIds: chat.disabledConnectorIds}, mcp);
          const skills = skillTools(ctx, storage);
          const hostToolNames = [...connectors, ...skills].map(t => t.name);
          const js = javascriptTool(ctx, {attachmentIds, hostToolNames, ...(storage ? {storage} : {})});
          return [...skills, js, ...connectors] satisfies FeatureTool[];
        },
        agentTools: async (ctx, {chat}) => visionTools(service, ctx, chat, storage),
      },
    },
  ];
}

export function localModules(baseUrl: string): (service: ApiService) => FeatureModule[] {
  return service => featureModules(service, {
    storage: createLocalToolsStorage(baseUrl),
    mcp: {publicOrigin: baseUrl, webReturnOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173']},
  });
}

/**
 * `look_at_image` is offered when the user's vision preference names a reader model and the chat's own
 * model can't take images (capability flag, never a provider name), matching the Swift runtime.
 */
export async function visionTools(service: ApiService, ctx: FeatureContext, chat: Chat, storage: ToolsStorage | undefined): Promise<AgentTool[]> {
  const prefsRow = await ctx.store.get(ctx.userId, 'preferences', 'current');
  if (!prefsRow || prefsRow.deleted) return [];
  const vision = PreferencesSchema.parse(prefsRow.value).vision;
  if (!vision.enabled || !vision.providerId || !vision.modelId || !storage) return [];
  const chatModel = chat.providerId && chat.modelId ? await ctx.store.get(ctx.userId, 'model', `${chat.providerId}:${chat.modelId}`) : null;
  if (chatModel && !chatModel.deleted && (chatModel.value as unknown as Model).capabilities.vision) return [];
  const provider = await readerProvider(service, ctx.userId, vision.providerId, vision.modelId);
  if (!provider) return [];
  return [
    cropImageReaderTool(createImageReaderTool({
      provider,
      crop: cropImage,
      modelId: vision.modelId,
      async resolveImage(userId, chatId, imageId): Promise<MessagePart | null> {
        const row = await ctx.store.get(userId, 'attachment', imageId);
        if (!row || row.deleted) return null;
        if (typeof row.value.chatId === 'string' && row.value.chatId !== chatId) return null;
        const file = await storage.read(userId, String(row.value.storageId));
        if (!file.mediaType.startsWith('image/')) return null;
        return {type: 'image', attachmentId: imageId, mediaType: file.mediaType, data: Buffer.from(file.bytes).toString('base64')};
      },
    })),
  ];
}

async function readerProvider(service: ApiService, userId: string, providerId: string, modelId: string): Promise<ModelProvider | null> {
  if (providerId === 'scripted') return service.local ? scriptedReader() : null;
  if (!service.providers) return null;
  await service.providers.requireConsent(userId, providerId);
  const {provider} = await service.providers.resolve(userId, providerId);
  const model = await service.adapters.store.get(userId, 'model', `${providerId}:${modelId}`);
  if (!model || model.deleted) return provider;
  return {flavor: provider.flavor, capabilities: (model.value as unknown as Model).capabilities, stream: (req, signal) => provider.stream(req, signal)};
}

/** Local dev reader for the scripted provider: deterministic, describes the request instead of the pixels. */
function scriptedReader(): ModelProvider {
  const capabilities = {type: 'capabilities' as const, tools: false, parallelToolCalls: false, vision: true, documents: false, imagesInToolResults: false, reasoningEffort: false, streamUsage: false, explicitPromptCaching: false, serverWebSearch: false, midConversationSystem: false, serverCompaction: false, toolSearch: false};
  return {
    flavor: 'openAIChat',
    capabilities,
    async *stream(request) {
      const question = request.messages.at(-1)?.parts.find(p => p.type === 'text')?.text ?? '';
      const text = `Scripted image reader received a ${request.messages.at(-1)?.parts.find(p => p.type === 'image')?.mediaType ?? 'image'} and the question: ${question}`;
      yield {type: 'completed', response: {parts: [{type: 'text', text}], stop: 'endTurn', usage: {type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0}}};
    },
  };
}
