import {
  AgentRunner, CheckpointSchema, ExecutionFenced, ToolResultSchema, createScriptedProvider, isRunControl, scriptedTools, textResult,
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
  /** Tools already shaped for the loop (e.g. `look_at_image` from @praxis/agent). */
  agentTools?(ctx: FeatureContext, input: {chat: Chat; runId: string; attachmentIds: string[]}): Promise<AgentTool[]>;
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
  /** One executor per run across instances (Upstash lease in production; process-local by default). */
  lease?: RunLease;
}

export interface RunLease {
  acquire(key: string, ttlMs: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

/** Process-local lease for dev/tests. Production passes the Redis lease (adapters/upstash.ts). */
export function memoryLease(clock: () => number = Date.now): RunLease {
  const held = new Map<string, {token: string; expires: number}>();
  return {
    async acquire(key, ttlMs) {
      const current = held.get(key);
      if (current && current.expires > clock()) return null;
      const token = crypto.randomUUID();
      held.set(key, {token, expires: clock() + ttlMs});
      return token;
    },
    async release(key, token) {
      if (held.get(key)?.token === token) held.delete(key);
    },
  };
}

type RunRequest = StartRun & {attachmentIds: string[]};

export function createExecutionDriver(options: ExecutionOptions): ExecutionDriver & {continue(userId: string, runId: string): Promise<void>} {
  const {service} = options;
  const clock = options.clock ?? Date.now;
  const budgetMs = options.budgetMs ?? 240_000;
  const scheduler: ContinuationScheduler = options.scheduler ?? {
    schedule: async (userId, runId) => service.enqueue(userId, runId, () => driver.continue(userId, runId)),
  };

  const lease = options.lease ?? memoryLease();
  const leaseTtlMs = budgetMs + 120_000;

  /**
   * Ports for one execution slice. Checkpoint writes are compare-and-set against the revision this slice
   * last read or wrote, so an executor that lost its lease (or a duplicate delivery) can't overwrite newer
   * state: its save throws ExecutionFenced and the slice stops without emitting anything else.
   */
  const slicePorts = (fence: {revision: number}): AgentPorts => ({
    ...ports,
    save: async (userId, cp) => {
      const row = await service.adapters.store.putIfRevision(userId, 'checkpoint', cp.run.id, JSON.parse(JSON.stringify(cp)), fence.revision, {parentId: cp.chat.id});
      if (!row) throw new ExecutionFenced();
      fence.revision = row.revision;
      await syncRun(userId, cp);
    },
  });

  async function syncRun(userId: string, cp: AgentCheckpoint) {
      const current = await service.require<Run>(userId, 'run', cp.run.id);
      cp.run.lastEventId = Math.max(cp.run.lastEventId, current.lastEventId);
      await service.put(userId, 'run', cp.run.id, cp.run);
      const chat = await service.require<Chat>(userId, 'chat', cp.chat.id).catch(() => null);
      if (chat && !chat.setup) {
        chat.setup = cp.setup;
        await service.write(userId, 'chat', chat.id, chat);
      }
  }

  /** Runs `fn` as the run's only executor; a concurrent or duplicate caller returns without doing anything. */
  async function exclusive(userId: string, runId: string, fn: (fence: {revision: number}) => Promise<AgentCheckpoint | void>) {
    const key = `run:${userId}:${runId}`;
    const token = await lease.acquire(key, leaseTtlMs);
    if (!token) return;
    let cp: AgentCheckpoint | void = undefined;
    try {
      const row = await service.adapters.store.get(userId, 'checkpoint', runId);
      cp = await fn({revision: row?.revision ?? 0});
    } catch (error) {
      if (!(error instanceof ExecutionFenced)) throw error;
    } finally {
      await lease.release(key, token);
    }
    // Schedule the next slice only after releasing the lease, or it would find the run still owned.
    if (cp) await settle(userId, cp);
  }

  async function trustedSources(userId: string): Promise<string[]> {
    return (await service.adapters.store.list(userId, 'connector'))
      .filter(r => !r.deleted && r.value.trusted === true && r.value.enabled !== false)
      .map(r => `mcp:${r.id}`);
  }

  const ports: Omit<AgentPorts, 'save'> = {
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
    if (options.features?.agentTools) {
      const extra = await options.features.agentTools(ctx(userId), {chat, runId: run.id, attachmentIds: request.attachmentIds});
      for (const tool of extra) if (!tools.some(t => t.spec.name === tool.spec.name)) tools.push(tool);
    }
    return tools;
  }

  async function runnerFor(userId: string, chat: Chat, run: Run, request: RunRequest, fence: {revision: number}) {
    const {provider, script, model} = await resolveProvider(userId, chat, request);
    const tools = await agentTools(userId, chat, run, request, script);
    const started = clock();
    const runner = new AgentRunner({
      provider,
      tools,
      ports: script ? {...slicePorts(fence), summarize: localSummary} : slicePorts(fence),
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
      await exclusive(userId, run.id, async fence => {
      const {runner, tools, model} = await runnerFor(userId, chat, run, stored, fence);
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
        policy: {trustedSources: await trustedSources(userId), alwaysAllow: []},
      });
      return cp;
      });
    },

    async resume(userId: string, runId: string, decision: RunDecision) {
      await exclusive(userId, runId, async fence => {
        const {cp, runner} = await load(userId, runId, fence);
        return runner.resume(cp, decision);
      });
    },

    async continue(userId: string, runId: string) {
      await exclusive(userId, runId, async fence => {
        const {cp, runner} = await load(userId, runId, fence);
        if (cp.run.status !== 'continuing') return;
        return runner.advance(cp);
      });
    },

    async cancel(userId: string, runId: string) {
      const row = await service.adapters.store.get(userId, 'checkpoint', runId);
      if (!row || row.deleted) return;
      const cp = CheckpointSchema.parse(row.value);
      if (cp.run.status === 'awaitingApproval' || cp.run.status === 'awaitingElicitation' || cp.run.status === 'continuing') {
        // A running executor sees the cancel flag between chunks; parked/continuing runs are finished here under the lease.
        await exclusive(userId, runId, async fence => {
          const {cp: current, runner} = await load(userId, runId, fence);
          await runner.cancel(current);
          return undefined;
        });
      }
    },
  };

  async function load(userId: string, runId: string, fence: {revision: number}) {
    const row = await service.adapters.store.get(userId, 'checkpoint', runId);
    if (!row || row.deleted) throw new ApiError(404, 'not_found', 'checkpoint not found');
    fence.revision = row.revision;
    const cp = CheckpointSchema.parse(row.value);
    // Trust is re-read every slice, so revoking a connector's trust applies to the rest of the run.
    cp.policy.trustedSources = await trustedSources(userId);
    const request = await service.require<RunRequest>(userId, 'runRequest', runId);
    const chat = await service.require<Chat>(userId, 'chat', cp.chat.id);
    const {runner} = await runnerFor(userId, {...chat, mode: cp.chat.mode}, cp.run, request, fence);
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
        // Park (nested approval/elicitation) and cancel are loop control flow, not tool failures.
        if (isRunControl(error) || error instanceof ExecutionFenced || context.signal.aborted) throw error;
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
