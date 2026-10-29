import {
  AgentRunner, CheckpointSchema, ToolResultSchema, createScriptedProvider, scriptedTools, textResult,
  type AgentCheckpoint, type AgentPorts, type AgentTool, type ModelProvider, type Script, type ToolResult,
} from '@praxis/agent';
import {
  JsonValueSchema, RunEventPayloadSchema,
  type Chat, type ConversationSetup, type JsonValue, type Message, type Model, type Run, type StartRun,
} from '@praxis/protocol';
import type {FeatureContext, FeatureTool} from './contracts.js';
import {buildSystemPrompt, skillCatalogSection, turnNotes, type CatalogSkill} from './conversation.js';
import {featureContext} from './features.js';
import {ApiError, type ApiService, type ExecutionDriver, type RunDecision} from './service.js';

/** Hands a run's next slice to a fresh invocation (QStash in production, the in-process queue locally). */
export interface ContinuationScheduler {
  schedule(userId: string, runId: string): Promise<void>;
}

/** Feature modules composed by the entry point (tools + MCP). All optional so tests can run the bare loop. */
export interface ExecutionFeatures {
  tools?(ctx: FeatureContext, input: {chat: Chat; runId: string; attachmentIds: string[]}): Promise<FeatureTool[]>;
  skills?(ctx: FeatureContext): Promise<CatalogSkill[]>;
  toolNotes?(ctx: FeatureContext, chat: Chat): Promise<string[]>;
}

export interface ExecutionOptions {
  service: ApiService;
  /** Wall-clock budget per slice; past it the run parks as `continuing` and is rescheduled. */
  budgetMs?: number;
  scheduler?: ContinuationScheduler;
  features?: ExecutionFeatures;
  encryptionKey?: string;
  fetcher?: typeof fetch;
  clock?: () => number;
  instructions?: string;
}

type RunRequest = StartRun & {attachmentIds: string[]};

export function createExecutionDriver(options: ExecutionOptions): ExecutionDriver & {continue(userId: string, runId: string): Promise<void>} {
  const {service} = options;
  const clock = options.clock ?? Date.now;
  const budgetMs = options.budgetMs ?? 240_000;
  const scheduler: ContinuationScheduler = options.scheduler ?? {
    schedule: async (userId, runId) => service.enqueue(userId, runId, () => driver.continue(userId, runId)),
  };

  const ports: AgentPorts = {
    save: async (userId, cp) => {
      await service.put(userId, 'checkpoint', cp.run.id, cp);
      const current = await service.require<Run>(userId, 'run', cp.run.id);
      cp.run.lastEventId = Math.max(cp.run.lastEventId, current.lastEventId);
      await service.put(userId, 'run', cp.run.id, cp.run);
      const chat = await service.require<Chat>(userId, 'chat', cp.chat.id).catch(() => null);
      if (chat && !chat.setup) {
        chat.setup = cp.setup;
        await service.write(userId, 'chat', chat.id, chat);
      }
    },
    emit: async (userId, runId, event) => service.emit(userId, runId, event),
    isCancelled: async (userId, runId) => !!(await service.adapters.kv.get(`cancel:${userId}:${runId}`)),
    spill: async (userId, runId, callId, text) => {
      const id = crypto.randomUUID();
      await service.put(userId, 'output', id, {type: 'tool.output', id, runId, callId, text});
      return id;
    },
  };

  const ctx = (userId: string) => featureContext(service, userId, {
    ...(options.fetcher ? {fetch: options.fetcher} : {}),
    ...(options.encryptionKey ? {encryptionKey: options.encryptionKey} : {}),
  });

  async function resolveProvider(userId: string, chat: Chat, request: RunRequest): Promise<{provider: ModelProvider; script?: Script; model?: Model}> {
    if (request.script) {
      if (!service.local) throw new ApiError(400, 'local_only', 'Scripted runs are local only');
      return {provider: scriptedProvider(request.script), script: request.script};
    }
    // Local dev keeps M1 behaviour: a chat without a provider runs the scripted provider.
    const providerId = request.providerId ?? chat.providerId ?? (service.local ? 'scripted' : undefined);
    if (!providerId) throw new ApiError(400, 'provider_required', 'Choose a model provider for this chat');
    if (providerId === 'scripted') {
      if (!service.local) throw new ApiError(400, 'local_only', 'Scripted runs are local only');
      return {provider: scriptedProvider('text'), script: 'text'};
    }
    if (!service.providers) throw new ApiError(503, 'providers_unavailable', 'Providers are not configured');
    await service.providers.requireConsent(userId, providerId);
    const {provider} = await service.providers.resolve(userId, providerId);
    const modelId = request.modelId ?? chat.modelId;
    const model = modelId
      ? await service.adapters.store.get(userId, 'model', `${providerId}:${modelId}`).then(r => (r && !r.deleted ? (r.value as unknown as Model) : undefined))
      : undefined;
    if (!model) return {provider};
    // Capabilities gate features per model, never by provider name.
    const scoped: ModelProvider = {
      flavor: provider.flavor,
      capabilities: model.capabilities,
      stream: (req, signal) => provider.stream(req, signal),
    };
    return {provider: scoped, model};
  }

  async function agentTools(userId: string, chat: Chat, run: Run, request: RunRequest, script?: Script): Promise<AgentTool[]> {
    const tools: AgentTool[] = script ? scriptedTools() : [];
    if (options.features?.tools) {
      const features = await options.features.tools(ctx(userId), {chat, runId: run.id, attachmentIds: request.attachmentIds});
      for (const tool of features) if (!tools.some(t => t.spec.name === tool.name)) tools.push(adaptTool(tool));
    }
    return tools;
  }

  async function runnerFor(userId: string, chat: Chat, run: Run, request: RunRequest) {
    const {provider, script, model} = await resolveProvider(userId, chat, request);
    const tools = await agentTools(userId, chat, run, request, script);
    const started = clock();
    const runner = new AgentRunner({
      provider,
      tools,
      ports: script ? {...ports, summarize: localSummary} : ports,
      shouldYield: () => clock() - started > budgetMs,
      ...(script === 'compaction' ? {contextWindow: 1024} : model?.contextWindow ? {contextWindow: model.contextWindow} : {}),
    } as ConstructorParameters<typeof AgentRunner>[0]);
    return {runner, tools, model, script};
  }

  async function freezeSetup(userId: string, chat: Chat, tools: AgentTool[]): Promise<ConversationSetup | undefined> {
    if (chat.setup) return undefined;
    const c = ctx(userId);
    const skills = (await options.features?.skills?.(c)) ?? [];
    const toolNotes = (await options.features?.toolNotes?.(c, chat)) ?? [];
    const offersSkills = tools.some(t => t.spec.name === 'load_skill' && !t.hidden);
    const catalogSkills = offersSkills ? skills : [];
    return {
      type: 'conversation.setup',
      system: buildSystemPrompt({skills: catalogSkills, toolNotes, ...(options.instructions ? {instructions: options.instructions} : {})}),
      tools: tools.filter(t => !t.hidden).map(t => t.spec),
      skillCatalog: skillCatalogSection(catalogSkills),
      connectorIds: chat.connectorIds,
      createdAt: service.now(),
    };
  }

  /** Runs the loop until it finishes, parks, or the slice budget ends; then schedules the next slice. */
  async function settle(userId: string, cp: AgentCheckpoint) {
    if (cp.run.status === 'continuing') await scheduler.schedule(userId, cp.run.id);
  }

  const driver = {
    async validate(userId: string, chat: Chat, input: StartRun) {
      await resolveProvider(userId, chat, {...input, attachmentIds: input.attachmentIds ?? []});
    },

    async notes(userId: string, chat: Chat, input: StartRun, previous: Message[]): Promise<string[]> {
      const skills = (await options.features?.skills?.(ctx(userId))) ?? [];
      return turnNotes({
        mode: input.mode ?? chat.mode,
        ...((input.effort ?? chat.effort) ? {effort: (input.effort ?? chat.effort)!} : {}),
        previous,
        ...(chat.setup ? {setup: chat.setup} : {}),
        skills,
      });
    },

    async start(userId: string, run: Run, chat: Chat, messages: Message[], request: StartRun) {
      const stored: RunRequest = {...request, attachmentIds: request.attachmentIds ?? []};
      await service.put(userId, 'runRequest', run.id, stored);
      const {runner, tools, model} = await runnerFor(userId, chat, run, stored);
      const setup = await freezeSetup(userId, chat, tools);
      const effort = request.effort ?? chat.effort;
      const modelId = request.modelId ?? chat.modelId;
      const cp = await runner.run({
        userId, run, messages,
        chat: {...chat, mode: request.mode ?? chat.mode},
        ...(setup ? {setup} : {}),
        ...(modelId ? {modelId} : {}),
        ...(effort ? {effort} : {}),
        ...(model?.reasoningEfforts.length ? {supportedEfforts: model.reasoningEfforts} : {}),
        ...(model?.maxOutputTokens ? {modelMaxTokens: model.maxOutputTokens} : {}),
        webSearch: request.webSearch,
      });
      await settle(userId, cp);
    },

    async resume(userId: string, runId: string, decision: RunDecision) {
      const {cp, runner} = await load(userId, runId);
      await settle(userId, await runner.resume(cp, decision));
    },

    async continue(userId: string, runId: string) {
      const {cp, runner} = await load(userId, runId);
      if (cp.run.status !== 'continuing') return;
      await settle(userId, await runner.advance(cp));
    },

    async cancel(userId: string, runId: string) {
      const row = await service.adapters.store.get(userId, 'checkpoint', runId);
      if (!row || row.deleted) return;
      const cp = CheckpointSchema.parse(row.value);
      if (cp.run.status === 'awaitingApproval' || cp.run.status === 'awaitingElicitation' || cp.run.status === 'continuing') {
        const {runner} = await load(userId, runId);
        await runner.cancel(cp);
      }
    },
  };

  async function load(userId: string, runId: string) {
    const cp = CheckpointSchema.parse(await service.require(userId, 'checkpoint', runId));
    const request = await service.require<RunRequest>(userId, 'runRequest', runId);
    const chat = await service.require<Chat>(userId, 'chat', cp.chat.id);
    const {runner} = await runnerFor(userId, {...chat, mode: cp.chat.mode}, cp.run, request);
    return {cp, runner};
  }

  return driver;
}

function scriptedProvider(script: Script): ModelProvider {
  const base = createScriptedProvider(script);
  if (script !== 'long') return base;
  return {
    ...base,
    async *stream(request, signal) {
      for await (const event of base.stream(request, signal)) {
        if (event.type === 'text') await new Promise(resolve => setTimeout(resolve, 12));
        yield event;
      }
    },
  };
}

async function localSummary(req: Parameters<NonNullable<AgentPorts['summarize']>>[0]) {
  const text = req.messages.map(m => m.parts.map(p => p.text ?? p.type).join(' ')).join('\n');
  return `Earlier conversation: ${text.slice(-2000)}`;
}

/** Bridges an API feature tool (MCP, builtin) onto the loop's tool port; the runner keeps policy. */
export function adaptTool(tool: FeatureTool): AgentTool {
  return {
    spec: {type: 'tool.spec', name: tool.name, description: tool.description, inputSchema: tool.inputSchema, source: tool.source, traits: tool.traits},
    ...(tool.classify ? {classify: (args: JsonValue) => tool.classify!(args)} : {}),
    async execute(args, context): Promise<ToolResult> {
      try {
        const value = await tool.execute(args, {
          chatId: context.chatId,
          runId: context.runId,
          mode: context.mode,
          callId: context.callId,
          signal: context.signal,
          elicit: request => context.elicit(request),
          callTool: async (name, nested) => JsonValueSchema.parse(await context.callTool(name, nested)),
          emit: async event => context.emit(RunEventPayloadSchema.parse(event)),
        });
        return toToolResult(value);
      } catch (error) {
        if (context.signal.aborted) throw error;
        const message = error instanceof ApiError || error instanceof Error ? error.message : 'Tool failed';
        return textResult(message, true);
      }
    },
  } as AgentTool;
}

export function toToolResult(value: JsonValue): ToolResult {
  const parsed = ToolResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof value === 'string') return textResult(value);
  return textResult(JSON.stringify(value));
}
