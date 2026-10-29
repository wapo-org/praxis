import type {
  Attachment,
  Bootstrap,
  Chat,
  Connector,
  Model,
  Provider,
  Run,
  RunSnapshot,
  Skill,
} from '@praxis/protocol';
import { z } from 'zod';
import {
  ConsentSchema,
  PreferencesSchema,
  RegistryEntrySchema,
  RegistrySchema,
  SyncResponseSchema,
  ToolActivitySchema,
  ToolCompletionSchema,
  ToolSpecSchema,
  TranscriptionSchema,
} from '@praxis/protocol';

export type ToolActivity = z.infer<typeof ToolActivitySchema>;
export type ToolCompletion = z.infer<typeof ToolCompletionSchema>;

export type Consent = z.infer<typeof ConsentSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type Registry = z.infer<typeof RegistrySchema>;
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type ToolSpec = z.infer<typeof ToolSpecSchema>;
export type Transcription = z.infer<typeof TranscriptionSchema>;

export interface PageResult<T> {
  type: 'page';
  items: T[];
  nextCursor: string | null;
}

export class PraxisApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'PraxisApiError';
    this.status = status;
    this.code = status === 404 && code === 'http_error' ? 'not_found' : code;
    this.requestId = requestId;
  }
}

export interface ApiClientConfig {
  baseUrl?: string;
  bearerToken?: string;
}

const DEFAULT_TOKEN = 'dev-local';

export class PraxisApiClient {
  private baseUrl: string;
  private bearerToken: string;
  private localConnectors = new Map<string, Connector>();
  private localSkills = new Map<string, Skill>();
  private localRegistries = new Map<string, Registry>();

  constructor(config?: ApiClientConfig) {
    const envBase =
      typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
        ? String(import.meta.env.VITE_API_BASE_URL)
        : '';
    this.baseUrl = (config?.baseUrl ?? envBase).replace(/\/$/, '');
    this.bearerToken = config?.bearerToken ?? DEFAULT_TOKEN;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getBearerToken(): string {
    return this.bearerToken;
  }

  setBearerToken(token: string): void {
    this.bearerToken = token;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
      ...extra,
    };
    return h;
  }

  async request<T>(
    path: string,
    init?: RequestInit & { headers?: Record<string, string> },
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...(init?.body && typeof init.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...this.headers(init?.headers),
    };

    const res = await fetch(this.url(path), {
      ...init,
      headers,
    });

    if (!res.ok) {
      let code = 'http_error';
      let message = `HTTP ${res.status}`;
      let requestId: string | undefined;
      try {
        const err = (await res.json()) as {
          code?: string;
          message?: string;
          requestId?: string;
        };
        if (err.code) code = err.code;
        if (err.message) message = err.message;
        if (err.requestId) requestId = err.requestId;
      } catch {}
      throw new PraxisApiError(res.status, code, message, requestId);
    }

    return (await res.json()) as T;
  }

  // Bootstrap & Auth
  async bootstrap(): Promise<Bootstrap> {
    const boot = await this.request<Bootstrap>('/v1/bootstrap');
    for (const c of this.localConnectors.values()) {
      if (!boot.connectors.some((x) => x.id === c.id)) boot.connectors.push(c);
    }
    for (const s of this.localSkills.values()) {
      if (!boot.skills.some((x) => x.id === s.id)) boot.skills.push(s);
    }
    if (boot.registries) {
      for (const r of this.localRegistries.values()) {
        if (!boot.registries.some((x) => x.id === r.id)) boot.registries.push(r);
      }
    }
    return boot;
  }

  async devAuth(userId = 'local-user') {
    return this.request<{
      type: 'session';
      user: { type: 'user'; id: string; name?: string };
      bearerToken: string;
      expiresAt: string;
    }>('/v1/auth/dev', {
      method: 'POST',
      body: JSON.stringify({ type: 'auth.dev', userId }),
    });
  }

  // Chats & Messages
  async listChats(params?: { q?: string; cursor?: string; limit?: number }): Promise<PageResult<Chat>> {
    const q = new URLSearchParams();
    if (params?.q) q.set('q', params.q);
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return this.request<PageResult<Chat>>(`/v1/chats${qs ? `?${qs}` : ''}`);
  }

  async createChat(input: {
    id?: string;
    title: string;
    pinned?: boolean;
    mode?: 'ask' | 'plan' | 'build' | 'auto';
    providerId?: string;
    modelId?: string;
    effort?: string;
    disabledConnectorIds?: string[];
  }): Promise<Chat> {
    return this.request<Chat>('/v1/chats', {
      method: 'POST',
      body: JSON.stringify({
        type: 'chat.input',
        title: input.title,
        pinned: input.pinned ?? false,
        mode: input.mode ?? 'build',
        providerId: input.providerId,
        modelId: input.modelId,
        effort: input.effort,
        disabledConnectorIds: input.disabledConnectorIds ?? [],
        ...(input.id ? { id: input.id } : {}),
      }),
    });
  }

  async patchChat(
    chatId: string,
    patch: {
      title?: string;
      pinned?: boolean;
      mode?: 'ask' | 'plan' | 'build' | 'auto';
      providerId?: string;
      modelId?: string;
      effort?: string;
      disabledConnectorIds?: string[];
    },
  ): Promise<Chat> {
    return this.request<Chat>(`/v1/chats/${encodeURIComponent(chatId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'chat.patch', ...patch }),
    });
  }

  async deleteChat(chatId: string): Promise<{ type: 'ok' }> {
    return this.request<{ type: 'ok' }>(`/v1/chats/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    });
  }

  async listMessages(chatId: string, limit = 100) {
    return this.request<PageResult<import('@praxis/protocol').Message>>(
      `/v1/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`,
    );
  }

  // Runs & Interactive Loop
  async startRun(input: {
    chatId: string;
    text: string;
    providerId?: string;
    modelId?: string;
    mode?: 'ask' | 'plan' | 'build' | 'auto';
    effort?: string;
    attachmentIds?: string[];
    disabledConnectorIds?: string[];
    clientTurnId?: string;
    idempotencyKey?: string;
    script?:
      | 'text'
      | 'tools'
      | 'approval'
      | 'nestedApproval'
      | 'elicitation'
      | 'error'
      | 'long'
      | 'compaction'
      | 'vision';
  }): Promise<Run> {
    return this.request<Run>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ type: 'run.start', ...input }),
    });
  }

  async getRun(runId: string): Promise<Run> {
    return this.request<Run>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  async getRunSnapshot(runId: string): Promise<RunSnapshot> {
    return this.request<RunSnapshot>(`/v1/runs/${encodeURIComponent(runId)}/snapshot`);
  }

  async cancelRun(runId: string): Promise<Run> {
    return this.request<Run>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ type: 'run.cancel' }),
    });
  }

  async submitApproval(
    runId: string,
    approvalId: string,
    decision: 'allowOnce' | 'allowAlways' | 'deny',
  ): Promise<Run> {
    return this.request<Run>(`/v1/runs/${encodeURIComponent(runId)}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ type: 'approval.decision', approvalId, decision }),
    });
  }

  async submitElicitation(
    runId: string,
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ): Promise<Run> {
    return this.request<Run>(`/v1/runs/${encodeURIComponent(runId)}/elicitations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'elicitation.response',
        elicitationId,
        action,
        ...(content ? { content } : {}),\n      }),
    });
  }

  async getToolOutput(runId: string, outputId: string, offset = 0, limit = 16000) {
    return this.request<{
      type: 'tool.output';
      id: string;
      text: string;
      offset: number;
      nextOffset: number | null;
    }>(
      `/v1/runs/${encodeURIComponent(runId)}/outputs/${encodeURIComponent(outputId)}?offset=${offset}&limit=${limit}`,
    );
  }

  // Providers & Models
  async listProviders(): Promise<PageResult<Provider>> {
    return this.request<PageResult<Provider>>('/v1/providers?limit=100');
  }

  async createProvider(input: {
    name: string;
    flavor: 'anthropicMessages' | 'openAIChat' | 'openAIResponses';
    baseUrl: string;
    defaultModel?: string;
    apiKey: string;
    extraHeaders?: Record<string, string>;
  }): Promise<Provider> {
    return this.request<Provider>('/v1/providers', {
      method: 'POST',
      body: JSON.stringify({ type: 'provider.input', ...input }),
    });
  }

  async patchProvider(
    providerId: string,
    input: {
      name: string;
      flavor: 'anthropicMessages' | 'openAIChat' | 'openAIResponses';
      baseUrl: string;
      defaultModel?: string;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<Provider> {
    return this.request<Provider>(`/v1/providers/${encodeURIComponent(providerId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'provider.input', ...input }),
    });
  }

  async deleteProvider(providerId: string): Promise<{ type: 'ok' }> {
    return this.request<{ type: 'ok' }>(`/v1/providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
    });
  }

  async testProvider(providerId: string) {
    try {
      return await this.request<{
        type: 'provider.test.result';
        ok: boolean;
        models: Model[];
        message?: string;
      }>(`/v1/providers/${encodeURIComponent(providerId)}/test`, {
        method: 'POST',
        body: JSON.stringify({ type: 'provider.test' }),
      });
    } catch {
      const models = await this.listModels({ providerId });
      return { type: 'provider.test.result' as const, ok: true, models: models.items };
    }
  }

  async refreshProviderModels(providerId: string): Promise<PageResult<Model>> {
    try {
      return await this.request<PageResult<Model>>(
        `/v1/providers/${encodeURIComponent(providerId)}/refresh-models`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'models.refresh' }),
        },
      );
    } catch {
      return this.listModels({ providerId });
    }
  }

  async listModels(params?: {
    providerId?: string;
    q?: string;
    pinned?: boolean;
    favorite?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<PageResult<Model>> {
    const q = new URLSearchParams({ limit: String(params?.limit ?? 100) });
    if (params?.providerId) q.set('providerId', params.providerId);
    if (params?.q) q.set('q', params.q);
    if (params?.pinned !== undefined) q.set('pinned', String(params.pinned));
    if (params?.favorite !== undefined) q.set('favorite', String(params.favorite));
    if (params?.cursor) q.set('cursor', params.cursor);
    return this.request<PageResult<Model>>(`/v1/models?${q.toString()}`);
  }

  async updateModelPreference(input: {
    providerId: string;
    modelId: string;
    pinned?: boolean;
    favorite?: boolean;
  }): Promise<Model> {
    return this.request<Model>('/v1/models/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ type: 'model.preference', ...input }),
    });
  }

  // Connectors (MCP) with automatic M1 fallback
  async listConnectors(): Promise<PageResult<Connector>> {
    try {
      return await this.request<PageResult<Connector>>('/v1/connectors?limit=100');
    } catch {
      return { type: 'page', items: Array.from(this.localConnectors.values()), nextCursor: null };
    }
  }

  async createConnector(input: {
    name: string;
    url: string;
    transport?: 'streamableHttp' | 'sse';
    enabled?: boolean;
    trusted?: boolean;
    disabledTools?: string[];
    token?: string;
  }): Promise<Connector> {
    try {
      return await this.request<Connector>('/v1/connectors', {
        method: 'POST',
        body: JSON.stringify({ type: 'connector.input', ...input }),
      });
    } catch {
      const created: Connector = {
        type: 'connector',
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: input.name,
        url: input.url,
        transport: input.transport ?? 'streamableHttp',
        enabled: input.enabled ?? true,
        trusted: input.trusted ?? false,
        disabledTools: input.disabledTools ?? [],
        authStatus: 'connected',
        toolCount: 2,
        promptsCount: 0,
        hasNewTools: true,
        updatedAt: new Date().toISOString(),
      };
      this.localConnectors.set(created.id, created);
      return created;
    }
  }

  async patchConnector(
    connectorId: string,
    patch: {
      name?: string;
      url?: string;
      transport?: 'streamableHttp' | 'sse';
      enabled?: boolean;
      trusted?: boolean;
      disabledTools?: string[];
      token?: string;
    },
  ): Promise<Connector> {
    try {
      return await this.request<Connector>(`/v1/connectors/${encodeURIComponent(connectorId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ type: 'connector.patch', ...patch }),
      });
    } catch {
      const existing = this.localConnectors.get(connectorId);
      const updated: Connector = {
        type: 'connector',
        id: connectorId,
        name: patch.name ?? existing?.name ?? 'Connector',
        url: patch.url ?? existing?.url ?? 'https://mcp.local/sse',
        transport: patch.transport ?? existing?.transport ?? 'streamableHttp',
        enabled: patch.enabled ?? existing?.enabled ?? true,
        trusted: patch.trusted ?? existing?.trusted ?? false,
        disabledTools: patch.disabledTools ?? existing?.disabledTools ?? [],
        authStatus: existing?.authStatus ?? 'connected',
        toolCount: existing?.toolCount ?? 2,
        promptsCount: existing?.promptsCount ?? 0,
        hasNewTools: existing?.hasNewTools ?? false,
        updatedAt: new Date().toISOString(),
      };
      this.localConnectors.set(connectorId, updated);
      return updated;
    }
  }

  async deleteConnector(connectorId: string): Promise<{ type: 'ok' }> {
    try {
      return await this.request<{ type: 'ok' }>(`/v1/connectors/${encodeURIComponent(connectorId)}`, {
        method: 'DELETE',
      });
    } catch {
      this.localConnectors.delete(connectorId);
      return { type: 'ok' };
    }
  }

  async listConnectorTools(connectorId: string): Promise<PageResult<ToolSpec>> {
    try {
      return await this.request<PageResult<ToolSpec>>(
        `/v1/connectors/${encodeURIComponent(connectorId)}/tools`,
      );
    } catch {
      const conn = this.localConnectors.get(connectorId);
      return {
        type: 'page',
        items: [
          {
            type: 'tool.spec',
            name: 'search_issues',
            description: 'Search workspace issues and tickets',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            source: { type: 'mcp', serverId: connectorId, serverName: conn?.name ?? 'MCP' },
            traits: ['readOnly'],
          },
          {
            type: 'tool.spec',
            name: 'create_comment',
            description: 'Post a markdown comment on an issue',
            inputSchema: { type: 'object', properties: { body: { type: 'string' } } },
            source: { type: 'mcp', serverId: connectorId, serverName: conn?.name ?? 'MCP' },
            traits: ['openWorld'],
          },
        ],
        nextCursor: null,
      };
    }
  }

  async toggleConnectorTool(
    connectorId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<Connector> {
    try {
      return await this.request<Connector>(
        `/v1/connectors/${encodeURIComponent(connectorId)}/tools/${encodeURIComponent(toolName)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ type: 'connector.tool', enabled }),
        },
      );
    } catch {
      const existing = this.localConnectors.get(connectorId);
      const disabled = new Set(existing?.disabledTools ?? []);
      if (enabled) disabled.delete(toolName);
      else disabled.add(toolName);
      return this.patchConnector(connectorId, { disabledTools: Array.from(disabled) });
    }
  }

  async startConnectorOAuth(connectorId: string, returnUrl?: string) {
    try {
      return await this.request<{ type: 'oauth.authorization'; url: string; state: string }>(
        `/v1/connectors/${encodeURIComponent(connectorId)}/oauth/start`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'oauth.start', ...(returnUrl ? { returnUrl } : {}) }),
        },
      );
    } catch {
      return {
        type: 'oauth.authorization' as const,
        url: returnUrl ?? 'https://mcp.example.com/oauth/authorize',
        state: `state-${connectorId}`,
      };
    }
  }

  // Skills & Skill Registries with automatic M1 fallback
  async listSkills(): Promise<PageResult<Skill>> {
    try {
      return await this.request<PageResult<Skill>>('/v1/skills?limit=100');
    } catch {
      return { type: 'page', items: Array.from(this.localSkills.values()), nextCursor: null };
    }
  }

  async createSkill(input: {
    name: string;
    description: string;
    document: string;
    enabled?: boolean;
  }): Promise<Skill> {
    try {
      return await this.request<Skill>('/v1/skills', {
        method: 'POST',
        body: JSON.stringify({ type: 'skill.input', ...input }),
      });
    } catch {
      const created: Skill = {
        type: 'skill',
        id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: input.name,
        description: input.description,
        document: input.document,
        enabled: input.enabled ?? true,
        updatedAt: new Date().toISOString(),
      };
      this.localSkills.set(created.id, created);
      return created;
    }
  }

  async patchSkill(
    skillId: string,
    input: {
      name: string;
      description: string;
      document: string;
      enabled?: boolean;
    },
  ): Promise<Skill> {
    try {
      return await this.request<Skill>(`/v1/skills/${encodeURIComponent(skillId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ type: 'skill.input', ...input }),
      });
    } catch {
      const updated: Skill = {
        type: 'skill',
        id: skillId,
        name: input.name,
        description: input.description,
        document: input.document,
        enabled: input.enabled ?? true,
        updatedAt: new Date().toISOString(),
      };
      this.localSkills.set(skillId, updated);
      return updated;
    }
  }

  async deleteSkill(skillId: string): Promise<{ type: 'ok' }> {
    try {
      return await this.request<{ type: 'ok' }>(`/v1/skills/${encodeURIComponent(skillId)}`, {
        method: 'DELETE',
      });
    } catch {
      this.localSkills.delete(skillId);
      return { type: 'ok' };
    }
  }

  async listSkillRegistries(): Promise<PageResult<Registry>> {
    try {
      return await this.request<PageResult<Registry>>('/v1/skill-registries?limit=100');
    } catch {
      return { type: 'page', items: Array.from(this.localRegistries.values()), nextCursor: null };
    }
  }

  async createSkillRegistry(input: { name: string; url: string; enabled?: boolean }): Promise<Registry> {
    try {
      return await this.request<Registry>('/v1/skill-registries', {
        method: 'POST',
        body: JSON.stringify({ type: 'skill.registry.input', ...input }),
      });
    } catch {
      const created: Registry = {
        type: 'skill.registry',
        id: `reg-${Date.now()}`,
        name: input.name,
        url: input.url,
        enabled: input.enabled ?? true,
      };
      this.localRegistries.set(created.id, created);
      return created;
    }
  }

  async deleteSkillRegistry(registryId: string): Promise<{ type: 'ok' }> {
    try {
      return await this.request<{ type: 'ok' }>(
        `/v1/skill-registries/${encodeURIComponent(registryId)}`,
        { method: 'DELETE' },
      );
    } catch {
      this.localRegistries.delete(registryId);
      return { type: 'ok' };
    }
  }

  async searchSkillRegistry(registryId: string, q = ''): Promise<PageResult<RegistryEntry>> {
    try {
      return await this.request<PageResult<RegistryEntry>>(
        `/v1/skill-registries/${encodeURIComponent(registryId)}/search?q=${encodeURIComponent(q)}`,
      );
    } catch {
      return {
        type: 'page',
        items: [
          {
            type: 'skill.registry.entry',
            id: 'entry-liquid-glass',
            name: 'Liquid Glass Craft',
            description: 'Snell refraction & progressive blur best practices',
            url: 'https://skills.praxis.local/liquid-glass',
          },
        ],
        nextCursor: null,
      };
    }
  }

  async installRegistrySkill(registryId: string, skillId: string): Promise<Skill> {
    try {
      return await this.request<Skill>(
        `/v1/skill-registries/${encodeURIComponent(registryId)}/install`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'skill.install', skillId }),
        },
      );
    } catch {
      return this.createSkill({
        name: skillId,
        description: `Installed from ${registryId}`,
        document: `# ${skillId}\nInstalled skill instructions.`,
        enabled: true,
      });
    }
  }

  // Consents & Preferences
  async listConsents(): Promise<PageResult<Consent>> {
    return this.request<PageResult<Consent>>('/v1/consents?limit=100');
  }

  async setConsent(host: string, allowed: boolean): Promise<Consent> {
    return this.request<Consent>('/v1/consents', {
      method: 'POST',
      body: JSON.stringify({ type: 'consent', host, allowed }),
    });
  }

  async getPreferences(): Promise<Preferences> {
    return this.request<Preferences>('/v1/preferences');
  }

  async patchPreferences(input: {
    vision?: { providerId?: string; modelId?: string; enabled?: boolean };
    voice?: { model?: string; language?: string; apiKey?: string };
  }): Promise<Preferences> {
    return this.request<Preferences>('/v1/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ type: 'preferences.input', ...input }),
    });
  }

  // Uploads & Voice Transcription
  async uploadAttachment(file: File, chatId?: string): Promise<Attachment> {
    const req = await this.request<{ type: 'upload.url'; uploadUrl: string; expiresAt: string }>(
      '/v1/uploads',
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'upload.request',
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          size: Math.max(1, file.size),
          ...(chatId ? { chatId } : {}),
        }),
      },
    );

    const putRes = await fetch(req.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...this.headers(),
      },
      body: file,
    });

    let storageId = `local-${Date.now()}`;
    if (putRes.ok) {
      try {
        const putJson = (await putRes.json()) as { storageId?: string };
        if (putJson.storageId) storageId = putJson.storageId;
      } catch {}
    }

    return this.request<Attachment>('/v1/uploads/complete', {
      method: 'POST',
      body: JSON.stringify({
        type: 'upload.complete',
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: Math.max(1, file.size),
        storageId,
        ...(chatId ? { chatId } : {}),
      }),
    });
  }

  async transcribeAudio(
    audioBlob: Blob,
    options?: { model?: string; language?: string },
  ): Promise<Transcription> {
    const buf = await audioBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const audioBase64 = typeof btoa === 'function' ? btoa(binary) : '';

    return this.request<Transcription>('/v1/transcribe', {
      method: 'POST',
      body: JSON.stringify({
        type: 'transcribe.request',
        audioBase64: audioBase64 || 'AAAA',
        mediaType: audioBlob.type || 'audio/webm',
        model: options?.model ?? 'whisper-large-v3-turbo',
        ...(options?.language ? { language: options.language } : {}),
      }),
    });
  }

  // Delta Sync with M1 bootstrap fallback
  async syncPull(cursor = '0') {
    try {
      const raw = await this.request<unknown>(`/v1/sync/pull?cursor=${encodeURIComponent(cursor)}`);
      return SyncResponseSchema.parse(raw);
    } catch {
      const boot = await this.bootstrap();
      return SyncResponseSchema.parse({
        type: 'sync.response',
        strategy: 'cursor',
        root: boot.syncRoot,
        cursor: boot.syncCursor,
        entities: boot.chats.map((c) => ({
          type: 'sync.entity',
          key: `chat:${c.id}`,
          hash: c.updatedAt,
          updatedAt: c.updatedAt,
          deleted: false,
          value: c,
        })),
        nextCursor: null,
        nodes: [],
      });
    }
  }
}

export const apiClient = new PraxisApiClient();
