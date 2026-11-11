import {titleModel} from './title-model.js';
import {executionSecrets} from './saved-secrets.js';
import {
  AgentRunner, CheckpointSchema, ExecutionFenced, ToolResultSchema, createScriptedProvider, isRunControl, scriptedTools, textResult,
  type AgentCheckpoint, type AgentPorts, type AgentTool, type ModelProvider, type Script, type ToolResult,
} from '@praxis/agent';
import {
  JsonValueSchema, RunEventPayloadSchema, type JsonObject,
  type Chat, type ConversationSetup, type JsonValue, type Message, type MessagePart, type Model, type Run, type StartRun, type StreamSimOptions,
} from '@praxis/protocol';
import type {FeatureContext, FeatureTool} from './contracts.js';
import {buildSystemPrompt, skillCatalogSection, turnNotes, type CatalogSkill} from './conversation.js';
import {featureContext} from './features.js';
import {ApiError, type ApiService, type ExecutionDriver, type RunDecision} from './service.js';
import {learnedFor, recordLearning} from './learning.js';
import {withMedia, type ModelCapabilities} from './media-provider.js';
import {readToolOutputTool} from './read-tool-output.js';

export {LEARNED_LIFETIME_MS} from './learning.js';
export {withMedia} from './media-provider.js';
export {readToolOutputTool} from './read-tool-output.js';

/** Hands a run's next slice to a fresh invocation (QStash in production, the in-process queue locally). */
export interface ContinuationScheduler {
  schedule(userId: string, runId: string): Promise<void>;
}

/** Feature modules composed by the entry point (tools + MCP). All optional so tests can run the bare loop. */
export interface ExecutionFeatures {
  refreshCatalog?: boolean;
  tools?(ctx: FeatureContext, input: {chat: Chat; runId: string; attachmentIds: string[]}): Promise<FeatureTool[]>;
  /** Tools already shaped for the loop (e.g. `look_at_image` from @praxis/agent). */
  agentTools?(ctx: FeatureContext, input: {chat: Chat; runId: string; attachmentIds: string[]}): Promise<AgentTool[]>;
  skills?(ctx: FeatureContext): Promise<CatalogSkill[]>;
  toolNotes?(ctx: FeatureContext, chat: Chat): Promise<string[]>;
  /**
   * Resolves an attachment reference for an outgoing provider request (history keeps references): bytes the model
   * can take, inlined text, or a note saying why it can't be shown.
   */
  media?(ctx: FeatureContext, part: MessagePart, capabilities: ModelCapabilities): Promise<MessagePart>;
  /** Extra notes for the new user turn (e.g. connector availability), given the notes already in the transcript. */
  turnNotes?(ctx: FeatureContext, chat: Chat, previousNotes: string[]): Promise<string[]>;
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
  acquire(key: string, ttlMs: number, ownerId?: string): Promise<string | null>;
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
    const token = await lease.acquire(key, leaseTtlMs, userId);
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
    if (cp) await recordLearning(service, userId, cp, clock()).catch(() => undefined);
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
      const run = await service.require<Run>(userId, 'run', runId);
      await service.put(userId, 'output', id, {type: 'tool.output', id, runId, chatId: run.chatId, callId, text});
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
      return {provider: scriptedProvider(request.script, request.streamSim), script: request.script};
    }
    // Local dev keeps M1 behaviour: a chat without a provider runs the scripted provider.
    const providerId = request.providerId ?? chat.providerId ?? (service.local ? 'scripted' : undefined);
    if (!providerId) throw new ApiError(400, 'provider_required', 'Choose a model provider for this chat');
    if (providerId === 'scripted') {
      if (!service.local) throw new ApiError(400, 'local_only', 'Scripted runs are local only');
      return {provider: scriptedProvider('text', request.streamSim), script: 'text'};
    }
    if (!service.providers) throw new ApiError(503, 'providers_unavailable', 'Providers are not configured');
    if(!(await service.adapters.store.get(userId,'provider',providerId))?.value)throw new ApiError(409,'provider_missing','Your selected provider is no longer available. Choose a provider in Settings and try again.');
    await service.providers.requireConsent(userId, providerId);
    const {provider} = await service.providers.resolve(userId, providerId);
    const modelId = request.modelId ?? chat.modelId;
    const model = modelId
      ? await service.adapters.store.get(userId, 'model', `${providerId}:${modelId}`).then(r => (r && !r.deleted ? (r.value as unknown as Model) : undefined))
      : undefined;
    if (!model) return {provider};
    // Capabilities gate features per model, never by provider name; rejections learned from the provider narrow them.
    const learned = await learnedFor(service, userId, providerId, model.id, clock());
    const capabilities = {...model.capabilities, ...(learned.images ? {vision: false} : {}), ...(learned.tools ? {tools: false} : {})};
    const scoped: ModelProvider = {
      flavor: provider.flavor,
      capabilities,
      stream: (req, signal) => provider.stream(req, signal),
    };
    return {provider: scoped, model: learned.efforts ? {...model, reasoningEfforts: learned.efforts} : model};
  }

  async function agentTools(userId: string, chat: Chat, run: Run, request: RunRequest, script?: Script): Promise<AgentTool[]> {
    const tools: AgentTool[] = [...(script ? scriptedTools() : []), readToolOutputTool(service)];
    if (options.features?.tools) {
      const features = await options.features.tools(ctx(userId), {chat, runId: run.id, attachmentIds: request.attachmentIds});
      for (const tool of features) if (!tools.some(t => t.spec.name === tool.name)) tools.push(adaptTool(tool, ctx(userId)));
    }
    if (options.features?.agentTools) {
      const extra = await options.features.agentTools(ctx(userId), {chat, runId: run.id, attachmentIds: request.attachmentIds});
      for (const tool of extra) if (!tools.some(t => t.spec.name === tool.spec.name)) tools.push(tool);
    }
    return tools;
  }

  async function runnerFor(userId: string, chat: Chat, run: Run, request: RunRequest, fence: {revision: number}) {
    const resolved = await resolveProvider(userId, chat, request);
    const {script, model} = resolved;
    const media = options.features?.media;
    const provider = media && !script ? withMedia(resolved.provider, (part, caps) => media(ctx(userId), part, caps)) : resolved.provider;
    const tools = await agentTools(userId, chat, run, request, script);
    const started = clock();
    const runner = new AgentRunner({
      provider,
      tools,
      toolNotes: await options.features?.toolNotes?.(ctx(userId),chat),
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
      hiddenTools: tools.filter(t => t.hidden).map(t => t.spec),
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
    async title(userId:string,chat:Chat,text:string) {
      if(!text.trim()||!chat.providerId)return;
      const started=clock();
      const model=titleModel((await service.list<Model>(userId,'model')).filter(m=>m.providerId===chat.providerId));
      if(!model)return;
      try {
        if(chat.providerId!=='scripted')await service.providers?.requireConsent(userId,chat.providerId);
        const resolved=await resolveProvider(userId,chat,{type:'run.start',chatId:chat.id,text,attachmentIds:[],webSearch:false});
        const request={model:model.id,system:'Return only a short 3 to 5 word title for this chat. No quotes.',messages:[{type:'message' as const,id:'title',chatId:chat.id,role:'user' as const,parts:[{type:'text' as const,text:text.slice(0,600)}],createdAt:service.now(),updatedAt:service.now()}],tools:[],capabilities:resolved.provider.capabilities,maxTokens:20,webSearch:false};
        let result;
        if(chat.providerId==='scripted'){
          for await(const event of resolved.provider.stream(request,AbortSignal.timeout(3000)))if(event.type==='completed')result=event.response;
        }else result=await (await service.providers!.resolve(userId,chat.providerId)).provider.complete(request,AbortSignal.timeout(3000));
        if(!result)return;
        await service.put(userId,'titleMetric',chat.id,{latencyMs:clock()-started,inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,modelId:model.id});
        const title=result.parts.filter(p=>p.type==='text').map(p=>p.text??'').join('').trim().replace(/^["']|["']$/g,'');
        return title.slice(0,42)||undefined;
      }catch{return;}
    },
    async validate(userId: string, chat: Chat, input: StartRun) {
      await resolveProvider(userId, chat, {...input, attachmentIds: input.attachmentIds ?? []});
    },

    async notes(userId: string, chat: Chat, input: StartRun, previous: Message[]): Promise<string[]> {
      const skills = (await options.features?.skills?.(ctx(userId))) ?? [];
      const previousNotes = previous.filter(m => m.role === 'user').flatMap(m => m.parts).flatMap(p => (p.type === 'note' && p.text ? [p.text] : []));
      const extra = (await options.features?.turnNotes?.(ctx(userId), chat, previousNotes)) ?? [];
      return [...turnNotes({
        mode: input.mode ?? chat.mode,
        ...((input.effort ?? chat.effort) ? {effort: (input.effort ?? chat.effort)!} : {}),
        previous,
        ...(chat.setup ? {setup: chat.setup} : {}),
        skills,
      }), ...extra];
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
        chat: {...chat, mode: request.mode ?? chat.mode, ...(options.features?.refreshCatalog&&chat.setup?{setup:{...chat.setup,tools:tools.filter(t=>!t.hidden).map(t=>t.spec),hiddenTools:tools.filter(t=>t.hidden).map(t=>t.spec)}}:{})},
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
      // A continuation for a run that was deleted (truncate/chat delete) is acknowledged as done, so QStash stops retrying.
      const row = await service.adapters.store.get(userId, 'checkpoint', runId);
      if (!row || row.deleted) return;
      await exclusive(userId, runId, async fence => {
        const current = await service.adapters.store.get(userId, 'checkpoint', runId);
        if (!current || current.deleted) return;
        fence.revision = current.revision;
        const pending = CheckpointSchema.parse(current.value);
        // Repair delivery before loading providers/tools: terminal and parked runs need no remote credentials.
        if (pending.outbox.length) {
          await service.emit(userId, runId, {type: 'messages.committed', messages: pending.outbox});
          pending.outbox = [];
          await slicePorts(fence).save(userId, pending);
        }
        if (['completed', 'failed', 'cancelled', 'awaitingApproval', 'awaitingElicitation'].includes(pending.run.status)) return;
        const {cp, runner} = await load(userId, runId, fence);
        // A redelivery may find a running checkpoint whose previous executor crashed.
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

function scriptedProvider(script: Script, simOptions?: StreamSimOptions): ModelProvider {
  const base = createScriptedProvider(script, simOptions);
  if (script !== 'long' && script !== 'streamSim') return base;
  return {
    ...base,
    async *stream(request, signal) {
      let chars = 0, stalled = false, count = 0;
      const start = Date.now();
      for await (const event of base.stream(request, signal)) {
        if (signal.aborted) throw signal.reason ?? new Error('Aborted');
        if (script === 'streamSim' && event.type === 'blockEnd' && event.redacted) await new Promise(resolve => setTimeout(resolve,350));
        if (event.type === 'text' || event.type === 'reasoning') {
          chars += event.text.length;
          const speed = simOptions?.speed ?? '40tps';
          const rate = speed === '2tps' ? 2 : speed === '1500tps' ? 1500 : 40;
          const wait = script === 'long' ? 12 : speed === 'instant' ? 0 :
            speed === 'burstStall' ? (!stalled && chars > 24 ? (stalled = true, simOptions?.stallDuration === '10s' ? 10000 : 3000) : 0) :
            speed === 'jitter' ? (++count % 5) * 18 : Math.max(0, start + chars / (rate * 4) * 1000 - Date.now());
          if (wait) await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, wait);
            signal.addEventListener('abort', abort, {once:true});
          });
        }
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
export function adaptTool(tool: FeatureTool, featureCtx?: FeatureContext): AgentTool {
  return {
    spec: {type: 'tool.spec', ...(tool.originalName ? {originalName:tool.originalName} : {}), name: tool.name, description: tool.description, inputSchema: tool.inputSchema, source: tool.source, traits: tool.traits},
    ...(tool.classify ? {classify: (args: JsonValue) => tool.classify!(args)} : {}),
    ...(tool.hidden ? {hidden: true} : {}),
    async execute(args, context): Promise<ToolResult> {
      try {
        const secrets=featureCtx?await executionSecrets(featureCtx,context.chatId):undefined;
        await secrets?.touch(args);
        let executionArgs=args;
        if(secrets&&args&&typeof args==='object'&&!Array.isArray(args)){
          executionArgs={...args};
          for(const key of ['env','headers'])if(args[key])executionArgs[key]=secrets.resolve(args[key]!);
        }
        const value = await tool.execute(executionArgs, {
          chatId: context.chatId,
          runId: context.runId,
          mode: context.mode,
          callId: context.callId,
          signal: context.signal,
          elicit: request => context.elicit(request),
          callTool: async (name, nested) => JsonValueSchema.parse(await context.callTool(name, secrets?secrets.redact(nested):nested)),
          emit: async event => context.emit(RunEventPayloadSchema.parse(secrets?secrets.redact(event):event)),
        });
        return toToolResult(secrets?secrets.redact(value):value);
      } catch (error) {
        // Park (nested approval/elicitation) and cancel are loop control flow, not tool failures.
        if (isRunControl(error) || error instanceof ExecutionFenced || context.signal.aborted) throw error;
        const message = error instanceof ApiError || error instanceof Error ? error.message : 'Tool failed';
        const secrets=featureCtx?await executionSecrets(featureCtx,context.chatId):undefined;
        return textResult(String(secrets?secrets.redact(message):message), true);
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
