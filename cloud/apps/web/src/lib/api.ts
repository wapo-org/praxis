import type {
  Attachment,
  Bootstrap,
  Capabilities,
  Chat,
  Model,
  Provider,
  Run,
  RunSnapshot,
} from '@praxis/protocol';
import { ProviderTestResultSchema, SyncResponseSchema } from '@praxis/protocol';
import { FeatureApiClient } from './api-features';
import {
  PraxisApiError,
  type Consent,
  type PageResult,
  type Preferences,
  type Transcription,
} from './api-transport';
import { safeMessage } from './links';
export * from './api-transport';
export class PraxisApiClient extends FeatureApiClient {
  // Bootstrap & Auth
  async bootstrap(): Promise<Bootstrap> {
    return this.request<Bootstrap>('/v1/bootstrap');
  }

  // Chats & Messages
  async listChats(params?: {
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<PageResult<Chat>> {
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

  async truncateChat(chatId: string, messageId?: string): Promise<{ type: 'ok' } | Chat> {
    return this.request<{ type: 'ok' } | Chat>(`/v1/chats/${encodeURIComponent(chatId)}/truncate`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'chat.truncate',
        ...(messageId ? { messageId } : {}),
      }),
    });
  }

  async getChat(chatId: string): Promise<Chat> {
    return this.request(`/v1/chats/${encodeURIComponent(chatId)}`);
  }

  async getAttachment(id: string): Promise<Attachment> {
    return this.request(`/v1/uploads/${encodeURIComponent(id)}`);
  }

  async listMessages(chatId: string, limit = 100) {
    const page = await this.request<PageResult<import('@praxis/protocol').Message>>(
      `/v1/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`,
    );
    return { ...page, items: page.items.map(safeMessage) };
  }

  // Runs & Interactive Loop
  async startRun(input: {
    chatId: string;
    text: string;
    providerId?: string;
    modelId?: string;
    mode?: 'ask' | 'plan' | 'build' | 'auto';
    effort?: string;
    webSearch?: boolean;
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
    const snapshot = await this.request<RunSnapshot>(
      `/v1/runs/${encodeURIComponent(runId)}/snapshot`,
    );
    return { ...snapshot, messages: snapshot.messages.map(safeMessage) };
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
      body: JSON.stringify({
        type: 'approval.decision',
        approvalId,
        decision,
      }),
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
    apiKey?: string;
    capabilities?: Capabilities;
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
      capabilities?: Capabilities;
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

  async testProvider(providerId: string, modelId?: string) {
    return ProviderTestResultSchema.parse(
      await this.request(`/v1/providers/${encodeURIComponent(providerId)}/test`, {
        method: 'POST',
        body: JSON.stringify({ type: 'provider.test', ...(modelId ? { modelId } : {}) }),
      }),
    );
  }

  async refreshProviderModels(providerId: string): Promise<PageResult<Model>> {
    return await this.request<PageResult<Model>>(
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
    const req = await this.request<{
      type: 'upload.url';
      uploadUrl: string;
      expiresAt: string;
      method?: 'POST' | 'PUT';
    }>('/v1/uploads', {
      method: 'POST',
      body: JSON.stringify({
        type: 'upload.request',
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: Math.max(1, file.size),
        ...(chatId ? { chatId } : {}),
      }),
    });

    const uploadTargetUrl = req.uploadUrl.startsWith('/') ? this.url(req.uploadUrl) : req.uploadUrl;
    const isApiOrigin = this.isApiOriginUrl(req.uploadUrl);
    const uploadHeaders: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
      ...(isApiOrigin ? this.headers() : {}),
    };

    const uploadRes = await fetch(uploadTargetUrl, {
      method: req.method ?? 'PUT',
      headers: uploadHeaders,
      body: file,
      credentials: isApiOrigin ? 'include' : 'omit',
    });

    if (isApiOrigin && uploadRes.status === 401) this.onUnauthorized?.();
    if (!uploadRes.ok) {
      let code = 'upload_failed';
      let message = `Upload failed with HTTP ${uploadRes.status}`;
      let requestId: string | undefined;
      try {
        const err = (await uploadRes.json()) as {
          code?: string;
          message?: string;
          requestId?: string;
        };
        if (err.code) code = err.code;
        if (err.message) message = err.message;
        if (err.requestId) requestId = err.requestId;
      } catch {}
      throw new PraxisApiError(uploadRes.status, code, message, requestId);
    }

    let storageId = '';
    try {
      const receipt = (await uploadRes.json()) as { storageId?: string };
      if (typeof receipt.storageId === 'string' && receipt.storageId.trim()) {
        storageId = receipt.storageId.trim();
      }
    } catch {}

    if (!storageId) {
      throw new PraxisApiError(
        502,
        'upload_invalid_receipt',
        'Upload target did not return a valid storageId receipt',
      );
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
        audioBase64,
        mediaType: audioBlob.type || 'audio/webm',
        model: options?.model ?? 'whisper-large-v3-turbo',
        ...(options?.language ? { language: options.language } : {}),
      }),
    });
  }

  // Delta Sync
  async syncPull(cursor = '0') {
    const raw = await this.request<unknown>(`/v1/sync/pull?cursor=${encodeURIComponent(cursor)}`);
    return SyncResponseSchema.parse(raw);
  }
}

export const apiClient = new PraxisApiClient();
