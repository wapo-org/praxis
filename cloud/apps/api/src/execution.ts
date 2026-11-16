import {createTitleGenerator} from './title-generation.js';
export {TITLE_SYSTEM,formatTitleUserMessage} from './title-generation.js';
import {adaptTool} from './execution-tools.js';
export {adaptTool,toToolResult} from './execution-tools.js';
import {variablesTool,variablePrompt} from './variables.js';
import {
  AgentRunner, CheckpointSchema, ExecutionFenced, createScriptedProvider, scriptedTools,
  type AgentCheckpoint, type AgentPorts, type AgentTool, type ModelProvider, type Script,
} from '@praxis/agent';
import {
  REASONING_EFFORTS, type CatalogModel, type Chat, type ConversationSetup, type StreamSimOptions, type Message, type MessagePart, type Run, type StartRun,
} from '@praxis/protocol';
import type {FeatureContext, FeatureTool} from './contracts.js';
import {buildSystemPrompt, skillCatalogSection, turnNotes, type CatalogSkill} from './conversation.js';
import {featureContext} from './features.js';
import {listConnectorsMemo} from './features/mcp/tools.js';
import {ApiError, type ApiService, type ExecutionDriver, type RunDecision} from './service.js';
import {isScripted} from './openrouter/index.js';
import {withMedia, type ModelCapabilities} from './media-provider.js';
import {readToolOutputTool} from './read-tool-output.js';
import {currentRunTiming, timedStep} from './timing.js';

export {withMedia} from './media-provider.js';
export {readToolOutputTool} from './read-tool-output.js';

/** Hands a run's next slice to a fresh invocation (QStash in production, the in-process queue locally). */
export interface ContinuationScheduler {
  schedule(userId: string, runId: string): Promise<void>;
}

/** Composed feature modules (tools, MCP); optional so tests can run bare loops. */
export interface ExecutionFeatures {
  refreshCatalog?: boolean;
  tools?(ctx: FeatureContext, input: {chat: Chat; runId: string; attachmentIds: string[]}): Promise<FeatureTool[]>;
  agentTools?(ctx: FeatureContext, input: {chat: Chat; runId: string; attachmentIds: string[]}): Promise<AgentTool[]>;
  skills?(ctx: FeatureContext): Promise<CatalogSkill[]>;
  toolNotes?(ctx: FeatureContext, chat: Chat): Promise<string[]>;
  /** Resolves an attachment reference into model-compatible bytes, text, or an omission note. */
  media?(ctx: FeatureContext, part: MessagePart, capabilities: ModelCapabilities): Promise<MessagePart>;
  /** Builds extra turn notes (e.g. connector status) not yet in transcript. */
  turnNotes?(ctx: FeatureContext, chat: Chat, previousNotes: string[]): Promise<string[]>;
}

export interface ExecutionOptions {
  service: ApiService;
  /** Wall-clock budget per slice; past it the run parks as `continuing` and is rescheduled. */
  budgetMs?: number;
  titleTimeoutMs?:number;
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

/** Process-local lease for dev/tests; production injects the Redis lease. */
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

  /** CAS-fenced checkpoint save throws ExecutionFenced if this slice lost its lease. */
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
      const [current, chat] = await Promise.all([
        service.require<Run>(userId, 'run', cp.run.id),
        service.require<Chat>(userId, 'chat', cp.chat.id).catch(() => null),
      ]);
      cp.run.lastEventId = Math.max(cp.run.lastEventId, current.lastEventId);
      const writes: Promise<unknown>[] = [service.put(userId, 'run', cp.run.id, cp.run)];
      if (chat && !chat.setup) {
        chat.setup = cp.setup;
        writes.push(service.write(userId, 'chat', chat.id, chat));
      }
      await Promise.all(writes);
  }

  /** Runs fn exclusively for this run; concurrent callers return without acting. */
  async function exclusive(userId: string, runId: string, fn: (fence: {revision: number}) => Promise<AgentCheckpoint | void>) {
    const key = `run:${userId}:${runId}`;
    const token = await timedStep('leaseAcquire', () => lease.acquire(key, leaseTtlMs, userId));
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
    // A 401 from OpenRouter marks the key, so every client shows the reconnect state.
    if (cp?.run.errorCode === 'model_key_invalid') await service.models?.keys.markInvalid(userId, cp.run.error ?? '').catch(() => undefined);
    // Schedule the next slice only after releasing the lease, or it would find the run still owned.
    if (cp) await settle(userId, cp);
  }

  async function trustedSources(userId: string): Promise<string[]> {
    const connectors = currentRunTiming()
      ? await listConnectorsMemo(ctx(userId))
      : (await service.adapters.store.list(userId, 'connector'))
          .filter(r => !r.deleted)
          .map(r => r.value as unknown as import('@praxis/protocol').Connector);
    return connectors
      .filter(r => r.trusted === true && r.enabled !== false)
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

  async function resolveProvider(userId: string, chat: Chat, request: RunRequest): Promise<{provider: ModelProvider; script?: Script; model?: CatalogModel; note?: string}> {
    if (request.script) {
      if (!service.local) throw new ApiError(400, 'local_only', 'Scripted runs are local only');
      return {provider: scriptedProvider(request.script), script: request.script};
    }
    const modelId = request.modelId ?? chat.modelId;
    // Local dev keeps M1 fallback to scripted provider.
    if (service.local && (!modelId || isScripted(modelId))) return {provider: scriptedProvider('text'), script: 'text'};
    if (!service.models) throw new ApiError(503, 'models_unavailable', 'Models are not configured');
    // User key is unsealed for this slice only and never checkpointed.
    return service.models.forRun(userId, modelId);
  }

  async function agentTools(userId: string, chat: Chat, run: Run, request: RunRequest, script?: Script): Promise<AgentTool[]> {
    const tools: AgentTool[] = [...(script ? scriptedTools(script) : []), readToolOutputTool(service), variablesTool(ctx(userId), service.search?.embedder)];
    const [features, extra] = await Promise.all([
      options.features?.tools
        ? options.features.tools(ctx(userId), {chat, runId: run.id, attachmentIds: request.attachmentIds})
        : Promise.resolve([]),
      options.features?.agentTools
        ? options.features.agentTools(ctx(userId), {chat, runId: run.id, attachmentIds: request.attachmentIds})
        : Promise.resolve([]),
    ]);
    for (const tool of features) if (!tools.some(t => t.spec.name === tool.name)) tools.push(adaptTool(tool, ctx(userId)));
    for (const tool of extra) if (!tools.some(t => t.spec.name === tool.spec.name)) tools.push(tool);
    return tools;
  }

  async function runnerFor(userId: string, chat: Chat, run: Run, request: RunRequest, fence: {revision: number}) {
    const scriptHint = request.script ?? (service.local && isScripted(request.modelId ?? chat.modelId) ? 'text' : undefined);
    const [resolved, tools, toolNotesList] = await Promise.all([
      timedStep('runnerProvider', () => resolveProvider(userId, chat, request)),
      timedStep('toolCatalog', () => agentTools(userId, chat, run, request, scriptHint)),
      timedStep('toolNotes', async () => options.features?.toolNotes?.(ctx(userId), chat)),
    ]);
    const {script, model} = resolved;
    const media = options.features?.media;
    const baseProvider = media && !script ? withMedia(resolved.provider, (part, caps) => media(ctx(userId), part, caps)) : resolved.provider;
    const tracker = currentRunTiming();
    const provider: ModelProvider = tracker
      ? {
          ...baseProvider,
          stream(req, signal) {
            tracker.mark('providerRequestMs');
            return baseProvider.stream(req, signal);
          },
        }
      : baseProvider;
    const started = clock();
    const runner = new AgentRunner({
      provider,
      tools,
      toolNotes: toolNotesList,
      ports: script ? {...slicePorts(fence), summarize: localSummary} : slicePorts(fence),
      shouldYield: () => clock() - started > budgetMs,
      ...(script === 'compaction' ? {contextWindow: 1024} : model ? {contextWindow: model.contextLength} : {}),
    } as ConstructorParameters<typeof AgentRunner>[0]);
    return {runner, tools, model, script, note: resolved.note};
  }

  async function freezeSetup(userId: string, chat: Chat, tools: AgentTool[]): Promise<ConversationSetup | undefined> {
    if (chat.setup) {
      const spec=variablesTool(ctx(userId),service.search?.embedder).spec;
      return {...chat.setup,system:chat.setup.system.includes('Saved variables exist:')?chat.setup.system:chat.setup.system+'\nSaved variables exist: use variables list/search/get; secrets are opaque references.',tools:chat.setup.tools.some(t=>t.name==='variables')?chat.setup.tools:[...chat.setup.tools,spec]};
    }
    const c = ctx(userId);
    const [skillsRaw, rawToolNotes] = await Promise.all([
      options.features?.skills?.(c) ?? Promise.resolve([]),
      timedStep('toolNotes', async () => options.features?.toolNotes?.(c, chat)),
    ]);
    const skills = skillsRaw ?? [];
    const toolNotes = [...(rawToolNotes ?? []), 'Saved variables exist: use variables list/search/get; secrets are opaque references and their values are never visible.'];
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

  async function settle(userId: string, cp: AgentCheckpoint) {
    if (cp.run.status === 'continuing') await scheduler.schedule(userId, cp.run.id);
  }

  const driver = {
    title: createTitleGenerator(service, resolveProvider, clock, options.titleTimeoutMs),
    async validate(userId: string, chat: Chat, input: StartRun) {
      await resolveProvider(userId, chat, {...input, attachmentIds: input.attachmentIds ?? []});
    },

    async notes(userId: string, chat: Chat, input: StartRun, previous: Message[]): Promise<string[]> {
      const needSkills = !!chat.setup?.tools.some(t => t.name === 'load_skill');
      const previousNotes = previous.filter(m => m.role === 'user').flatMap(m => m.parts).flatMap(p => (p.type === 'note' && p.text ? [p.text] : []));
      const [skills, extra] = await Promise.all([
        needSkills ? (options.features?.skills?.(ctx(userId)) ?? Promise.resolve([])) : Promise.resolve([]),
        options.features?.turnNotes?.(ctx(userId), chat, previousNotes) ?? Promise.resolve([]),
      ]);
      const variables = await variablePrompt(ctx(userId), input.text, service.search?.embedder, {deferTouch: work => { if (service.defer) service.defer(work); }});
      return [...turnNotes({
        mode: input.mode ?? chat.mode,
        ...((input.effort ?? chat.effort) ? {effort: (input.effort ?? chat.effort)!} : {}),
        previous,
        ...(chat.setup ? {setup: chat.setup} : {}),
        skills,
      }), ...extra, ...(variables ? [variables] : [])];
    },

    async start(userId: string, run: Run, chat: Chat, messages: Message[], request: StartRun) {
      const stored: RunRequest = {...request, attachmentIds: request.attachmentIds ?? []};
      await service.put(userId, 'runRequest', run.id, stored);
      await exclusive(userId, run.id, async fence => {
      const {runner, tools, model, note} = await runnerFor(userId, chat, run, stored, fence);
      if (note) run.note = note;
      const setup = await freezeSetup(userId, chat, tools);
      const effort = request.effort ?? chat.effort;
      const modelId = model?.id ?? request.modelId ?? chat.modelId;
      const cp = await runner.run({
        userId, run, messages,
        chat: {...chat, mode: request.mode ?? chat.mode},
        ...(setup ? {setup} : {}),
        ...(modelId ? {modelId} : {}),
        ...(effort ? {effort} : {}),
        ...(model?.capabilities.reasoning ? {supportedEfforts: [...REASONING_EFFORTS]} : {}),
        ...(model?.maxOutput ? {modelMaxTokens: model.maxOutput} : {}),
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
      // Acknowledge continuations for deleted runs as done so QStash stops retrying.
      const row = await service.adapters.store.get(userId, 'checkpoint', runId);
      if (!row || row.deleted) return;
      await exclusive(userId, runId, async fence => {
        const current = await service.adapters.store.get(userId, 'checkpoint', runId);
        if (!current || current.deleted) return;
        fence.revision = current.revision;
        const pending = CheckpointSchema.parse(current.value);
        // Repair delivery before loading providers/tools so parked runs need no remote secrets.
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
        // Running slices poll cancel between chunks; parked runs finish under lease.
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
  const base = createScriptedProvider(script);
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
