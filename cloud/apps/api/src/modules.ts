import {webTools} from './features/web/tools.js';
import type {WebPortsFor} from './features/web/ports.js';
import {composioTools} from './features/composio/tools.js';
import type {ComposioPortsFor} from './features/composio/ports.js';
import {selectRunTools} from './tool-selection.js';
import {cropImage, cropImageReaderTool} from './features/tools/image-crop.js';
import {connectorToolNotes} from './features/tools/tool-notes.js';
import {Hono} from 'hono';
import {createImageReaderTool, type AgentTool, type ModelProvider} from '@praxis/agent';
import {ConnectorSchema,PreferencesSchema, type Chat, type MessagePart} from '@praxis/protocol';
import {isScripted} from './openrouter/index.js';
import type {FeatureContext, FeatureTool} from './contracts.js';
import {connectorTurnNotes, createMcpGateway, createMcpRoutes, getMcpTools, type McpOptions} from './features/mcp/index.js';
import {createLocalToolsStorage, createToolsRoutes, type PlatformVoice, type ToolsStorage} from './features/tools/index.js';
import {rehydrateAttachment} from './features/tools/media.js';
import {javascriptTool, listSkillsForCatalog, skillTools} from './features/tools/builtin.js';
import type {FeatureModule} from './server.js';
import type {ApiService} from './service.js';
import {currentRunTiming, timedStep} from './timing.js';

export interface ModuleOptions {
  storage?: ToolsStorage;
  web?: WebPortsFor;
  composio?: ComposioPortsFor;
  mcp?: McpOptions;
  platformVoice?: PlatformVoice;
}

export function featureModules(service: ApiService, options: ModuleOptions = {}): FeatureModule[] {
  const storage = options.storage;
  const mcp = options.mcp ?? {};
  return [
    {
      deleteAccount: async userId=>{await storage?.purgeOwner?.(userId);},
      restoreAccount: async userId=>{await storage?.reopenOwner?.(userId);},
      publicPaths: ['/v1/connectors/oauth/callback', '/v1/oauth/client-metadata.json'],
      routes: contextFor => {
        const app = new Hono();
        app.route('/', createMcpRoutes(contextFor, mcp));
        app.route('/', createToolsRoutes(contextFor, {...(storage ? {storage} : {}), ...(options.platformVoice ? {platformVoice: options.platformVoice} : {})}));
        return app;
      },
      execution: {
        refreshCatalog:true,
        skills: ctx => {
          const tracker = currentRunTiming();
          const load = () => timedStep('skills', () => listSkillsForCatalog(ctx));
          return tracker ? tracker.memo(`skills:${ctx.userId}`, load) : load();
        },
        turnNotes: (ctx, chat, previous) => timedStep('connectorTurnNotes', () => connectorTurnNotes(ctx, chat, previous)),
        media: (ctx, part, caps) => rehydrateAttachment(ctx, storage, part, caps),
        toolNotes: async (ctx, chat) => {
          const [mcpTools, connectors] = await Promise.all([
            getMcpTools(ctx, {chatId: chat.id, disabledConnectorIds: chat.disabledConnectorIds}, mcp),
            ctx.store.list(ctx.userId, 'connector').then(rows => rows.filter(r => !r.deleted).map(r => ConnectorSchema.parse(r.value))),
          ]);
          return connectorToolNotes(mcpTools, connectors.filter(c=>c.enabled&&!chat.disabledConnectorIds.includes(c.id)));
        },
        async tools(ctx, {chat, attachmentIds}) {
          const connectors = await getMcpTools(ctx, {chatId: chat.id, disabledConnectorIds: chat.disabledConnectorIds}, mcp);
          const skills = skillTools(ctx, storage);
          const hostToolNames = [...connectors, ...skills].map(t => t.name);
          const js = javascriptTool(ctx, {attachmentIds, hostToolNames, ...(storage ? {storage} : {})});
          return [...skills, js, ...await selectRunTools(ctx, chat, connectors, service.search?.embedder)] satisfies FeatureTool[];
        },
        agentTools: async (ctx, {chat}) => [
          ...webTools(options.web?.(ctx), chat.webToolsEnabled !== false),
          ...composioTools(options.composio?.(ctx), ctx.userId, chat),
          ...await timedStep('visionTools', () => visionTools(service, ctx, chat, storage)),
        ],
      },
    },
  ];
}

/** Tool count threshold to switch to the hidden gateway trio. */
export const GATEWAY_THRESHOLD = 30;

/** Gateway vs direct-tool mode stays frozen on the chat for its lifetime. */
export function withGateway(chat: Chat, connectors: FeatureTool[]): FeatureTool[] {
  const frozen = chat.setup?.tools.map(t => t.name);
  const gateway = frozen ? frozen.includes('mcp_call_tool') : connectors.length > GATEWAY_THRESHOLD;
  if (!gateway) return connectors;
  // Catalog stays frozen on the chat; later connectors aren't added.
  const hidden = chat.setup?.hiddenTools?.map(t => t.name);
  const catalog = hidden ? connectors.filter(t => hidden.includes(t.name)) : connectors;
  return [...createMcpGateway(catalog), ...catalog.map(t => ({...t, hidden: true}))];
}

export function localModules(baseUrl: string): (service: ApiService) => FeatureModule[] {
  return service => featureModules(service, {
    storage: createLocalToolsStorage(baseUrl),
    mcp: {publicOrigin: baseUrl, webReturnOrigins: [...(process.env.PRAXIS_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean),'http://localhost:5173', 'http://127.0.0.1:5173']},
  });
}

/** Offers look_at_image only when a vision reader is set and chat model lacks vision. */
export async function visionTools(service: ApiService, ctx: FeatureContext, chat: Chat, storage: ToolsStorage | undefined): Promise<AgentTool[]> {
  if (!storage) return [];
  const prefsRow = await ctx.store.get(ctx.userId, 'preferences', 'current');
  if (!prefsRow || prefsRow.deleted) return [];
  const vision = PreferencesSchema.parse(prefsRow.value).vision;
  if (!vision.enabled || !vision.modelId || !storage) return [];
  // Offered only when the chat's own model can't take images, by its catalogue entry (never by name).
  const chatModel = chat.modelId && !isScripted(chat.modelId) ? await service.models?.catalog.find(chat.modelId).catch(() => undefined) : undefined;
  if (chatModel?.capabilities.images) return [];
  const provider = await readerProvider(service, ctx.userId, vision.modelId);
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

async function readerProvider(service: ApiService, userId: string, modelId: string): Promise<ModelProvider | null> {
  if (isScripted(modelId)) return service.local ? scriptedReader() : null;
  return (await service.models?.auxiliary(userId, modelId).catch(() => null)) ?? null;
}

/** Deterministic dev vision reader describing the request. */
function scriptedReader(): ModelProvider {
  const capabilities = {type: 'capabilities' as const, tools: false, parallelToolCalls: false, vision: true, documents: false, imagesInToolResults: false, reasoningEffort: false, streamUsage: false, explicitPromptCaching: false, serverWebSearch: false, midConversationSystem: false, serverCompaction: false, toolSearch: false};
  return {
    capabilities,
    async *stream(request) {
      const question = request.messages.at(-1)?.parts.find(p => p.type === 'text')?.text ?? '';
      const text = `Scripted image reader received a ${request.messages.at(-1)?.parts.find(p => p.type === 'image')?.mediaType ?? 'image'} and the question: ${question}`;
      yield {type: 'completed', response: {parts: [{type: 'text', text}], stop: 'endTurn', usage: {type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0}}};
    },
  };
}
