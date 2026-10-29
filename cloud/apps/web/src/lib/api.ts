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
    this.code = code;
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
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...extra,
    };
    return h;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const isJsonBody = typeof init?.body === 'string';
    const res = await fetch(this.url(path), {
      ...init,
      credentials: 'include',
      headers: {
        ...(isJsonBody ? { 'Content-Type': 'application/json' } : {}),
        ...this.headers(init?.headers as Record<string, string> | undefined),
      },
    });

    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = `Request failed (${res.status})`;
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

  // Auth & Bootstrap
  async devLogin(userId = 'local-user') {
    return this.request<{
      type: 'session';
      user: { id: string; name: string };
      bearerToken?: string;
      expiresAt: string;
    }>('/v1/auth/dev', {
      method: 'POST',
      body: JSON.stringify({ type: 'auth.dev', userId }),
    });
  }

  async bootstrap(): Promise<Bootstrap> {
    return this.request<Bootstrap>('/v1/bootstrap');
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
    title?: string;
    pinned?: boolean;
    mode?: 'ask' | 'plan' | 'build' | 'auto';
    providerId?: string;
    modelId?: string;
    effort?: string;
    connectorIds?: string[];
    disabledConnectorIds?: string[];
  }): Promise<Chat> {
    return this.request<Chat>('/v1/chats', {
      method: 'POST',
      body: JSON.stringify({ type: 'chat.input', ...input }),
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
      connectorIds?: string[];
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

  async listMessages(chatId: string, cursor?: string, limit = 100) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return this.request<PageResult<import('@praxis/protocol').Message>>(
      `/v1/chats/${encodeURIComponent(chatId)}/messages?${q.toString()}`,
    );
  }

  // Runs, Approvals, Elicitations
  async startRun(input: {
    chatId: string;
    text: string;
    providerId?: string;
    modelId?: string;
    mode?: 'ask' | 'plan' | 'build' | 'auto';
    effort?: string;
    attachmentIds?: string[];
    webSearch?: boolean;
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
        ...(content ? { content } : {}),
      }),
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
    return this.request<{ type: 'provider.test.result'; ok: boolean; models: Model[]; message?: string }>(
      `/v1/providers/${encodeURIComponent(providerId)}/test`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'provider.test' }),
      },
    );
  }

  async refreshProviderModels(providerId: string): Promise<PageResult<Model>> {
    return this.request<PageResult<Model>>(
      `/v1/providers/${encodeURIComponent(providerId)}/refresh-models`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'models.refresh' }),
      },
    );
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

  // Connectors (MCP)
  async listConnectors(): Promise<PageResult<Connector>> {
    return this.request<PageResult<Connector>>('/v1/connectors?limit=100');
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
    return this.request<Connector>('/v1/connectors', {
      method: 'POST',
      body: JSON.stringify({ type: 'connector.input', ...input }),
    });
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
    return this.request<Connector>(`/v1/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'connector.patch', ...patch }),
    });
  }

  async deleteConnector(connectorId: string): Promise<{ type: 'ok' }> {
    return this.request<{ type: 'ok' }>(`/v1/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'DELETE',
    });
  }

  async listConnectorTools(connectorId: string): Promise<PageResult<ToolSpec>> {
    return this.request<PageResult<ToolSpec>>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/tools`,
    );
  }

  async toggleConnectorTool(
    connectorId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<Connector> {
    return this.request<Connector>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/tools/${encodeURIComponent(toolName)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ type: 'connector.tool', enabled }),
      },
    );
  }

  async startConnectorOAuth(connectorId: string, returnUrl?: string) {
    return this.request<{ type: 'oauth.authorization'; url: string; state: string }>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/oauth/start`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'oauth.start', ...(returnUrl ? { returnUrl } : {}) }),
      },
    );
  }

  // Skills & Skill Registries
  async listSkills(): Promise<PageResult<Skill>> {
    return this.request<PageResult<Skill>>('/v1/skills?limit=100');
  }

  async createSkill(input: {
    name: string;
    description: string;
    document: string;
    enabled?: boolean;
  }): Promise<Skill> {
    return this.request<Skill>('/v1/skills', {
      method: 'POST',
      body: JSON.stringify({ type: 'skill.input', ...input }),
    });
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
    return this.request<Skill>(`/v1/skills/${encodeURIComponent(skillId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'skill.input', ...input }),
    });
  }

  async deleteSkill(skillId: string): Promise<{ type: 'ok' }> {
    return this.request<{ type: 'ok' }>(`/v1/skills/${encodeURIComponent(skillId)}`, {
      method: 'DELETE',
    });
  }

  async listSkillRegistries(): Promise<PageResult<Registry>> {
    return this.request<PageResult<Registry>>('/v1/skill-registries?limit=100');
  }

  async createSkillRegistry(input: { name: string; url: string; enabled?: boolean }): Promise<Registry> {
    return this.request<Registry>('/v1/skill-registries', {
      method: 'POST',
      body: JSON.stringify({ type: 'skill.registry.input', ...input }),
    });
  }

  async deleteSkillRegistry(registryId: string): Promise<{ type: 'ok' }> {
    return this.request<{ type: 'ok' }>(
      `/v1/skill-registries/${encodeURIComponent(registryId)}`,
      { method: 'DELETE' },
    );
  }

  async searchSkillRegistry(registryId: string, q = ''): Promise<PageResult<RegistryEntry>> {
    return this.request<PageResult<RegistryEntry>>(
      `/v1/skill-registries/${encodeURIComponent(registryId)}/search?q=${encodeURIComponent(q)}`,
    );
  }

  async installRegistrySkill(registryId: string, skillId: string): Promise<Skill> {
    return this.request<Skill>(
      `/v1/skill-registries/${encodeURIComponent(registryId)}/install`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'skill.install', skillId }),
      },
    );
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
        const receipt = (await putRes.json()) as { storageId?: string };
        if (receipt.storageId) storageId = receipt.storageId;
      } catch {}
    }

    return this.request<Attachment>('/v1/uploads/complete', {
      method: 'POST',
      body: JSON.stringify({
        type: 'upload.complete',
        storageId,
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        ...(chatId ? { chatId } : {}),
      }),
    });
  }

  async transcribeAudio(blob: Blob, options?: { model?: string; language?: string }): Promise<Transcription> {
    const form = new FormData();
    form.append('file', blob, 'recording.webm');
    if (options?.model) form.append('model', options.model);
    if (options?.language) form.append('language', options.language);

    return this.request<Transcription>('/v1/transcribe', {
      method: 'POST',
      body: form,
    });
  }

  // Sync endpoints
  async syncPull(cursor?: string, strategy: 'cursor' | 'merkle' = 'cursor') {
    return this.request<z.infer<typeof SyncResponseSchema>>(
      '/v1/sync/pull',
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'sync.request',
          strategy,
          ...(cursor ? { cursor } : {}),
          limit: 500,
        }),
      },
    );
  }
}

export const apiClient = new PraxisApiClient();
