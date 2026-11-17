import {enqueue, offlineFallback} from '../sync/outbox';
import {readReplicaSync} from './idb';
import type {
  Attachment,
  Bootstrap,
  ModelKey,
  ModelListItem,
  ModelPreferenceRecord,
  Chat,
  Run,
  RunSnapshot,
} from '@praxis/protocol';
import { SyncResponseSchema } from '@praxis/protocol';
import { UploadApiClient } from './api-uploads';
import {
  PraxisApiError,
  type Consent,
  type PageResult,
  type Preferences,
} from './api-transport';
import { safeMessage } from './links';
export * from './api-transport';
export interface SavedValue {id:string;name:string;kind:'secret'|'variable';value?:unknown;createdAt:string;lastUsedAt?:string|null}
export interface SavedValueQuery {query?:string;kind?:'secret'|'variable';since?:string;cursor?:string;limit?:number}
export class PraxisApiClient extends UploadApiClient {
  savedValues(){return this.request<{items:SavedValue[]}>('/v1/saved-values');}
  createSavedValue(input:{name:string;kind:'secret'|'variable';value:unknown}){return this.request('/v1/saved-values',{method:'POST',body:JSON.stringify(input)});}
  /** One page of saved values, newest first (L1's keyset pagination; the cursor is bound to the filters). */
  querySavedValues(q:SavedValueQuery,signal?:AbortSignal){
   const params=new URLSearchParams();
   for(const [k,v] of Object.entries(q))if(v!==undefined&&v!=='')params.set(k,String(v));
   return this.request<{items:SavedValue[];nextCursor:string|null}>('/v1/saved-values?'+params.toString(),signal?{signal}:{});
  }
  /** Rename and/or replace the value; a secret's value is write-only. */
  updateSavedValue(id:string,patch:{name?:string;value?:unknown}){return this.request('/v1/saved-values/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(patch)});}
  renameSavedValue(id:string,name:string){return this.request('/v1/saved-values/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({name})});}
  deleteSavedValue(id:string){return this.request('/v1/saved-values/'+encodeURIComponent(id),{method:'DELETE'});}
  savedSecrets(){return this.request<{items:{id:string;name:string;createdAt:string;lastUsedAt?:string}[]}>('/v1/saved-secrets');}
  renameSavedSecret(id:string,name:string){return this.request('/v1/saved-secrets/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({name})});}
  deleteSavedSecret(id:string){return this.request('/v1/saved-secrets/'+encodeURIComponent(id),{method:'DELETE'});}
  // Bootstrap & Auth
  async bootstrap(): Promise<Bootstrap> {
    return this.request<Bootstrap>('/v1/bootstrap');
  }

  async searchChats(q: string) {
    return this.request<PageResult<{ chat: Chat; snippet: string }>>(`/v1/search?${new URLSearchParams({ q, limit: '50' })}`);
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
    modelId?: string;
    effort?: string;
    disabledConnectorIds?: string[];
  }): Promise<Chat> {
    const id = input.id ?? crypto.randomUUID();
    const offline = (): Chat => {
      const now = new Date().toISOString();
      const chat: Chat = { type: 'chat', id, title: input.title, pinned: input.pinned ?? false, mode: input.mode ?? 'build', connectorIds: [], disabledConnectorIds: input.disabledConnectorIds ?? [], createdAt: now, updatedAt: now,  modelId: input.modelId, effort: input.effort };
      enqueue({ path: '/v1/chats', method: 'POST', body: JSON.stringify({ ...input, type: 'chat.input', id: chat.id }) });
      return chat;
    };
    return offlineFallback(() => this.request<Chat>('/v1/chats', {
      method: 'POST',
      body: JSON.stringify({
        type: 'chat.input',
        title: input.title,
        pinned: input.pinned ?? false,
        mode: input.mode ?? 'build',
        modelId: input.modelId,
        effort: input.effort,
        disabledConnectorIds: input.disabledConnectorIds ?? [],
        id,
      }),
    }), offline);
  }

  async patchChat(
    chatId: string,
    patch: {
      title?: string;
      pinned?: boolean;
      mode?: 'ask' | 'plan' | 'build' | 'auto';
        modelId?: string;
      effort?: string;
      disabledConnectorIds?: string[];
    },
  ): Promise<Chat> {
    const offline = (): Chat => {
      const chat = readReplicaSync()?.chats.find(c => c.id === chatId);
      if (!chat) throw Error('Chat is not cached for offline editing');
      enqueue({ path: `/v1/chats/${encodeURIComponent(chatId)}`, method: 'PATCH', body: JSON.stringify({ type: 'chat.patch', ...patch }) });
      return { ...chat, ...patch };
    };
    return offlineFallback(() => this.request<Chat>(`/v1/chats/${encodeURIComponent(chatId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'chat.patch', ...patch }),
    }), offline);
  }

  async deleteChat(chatId: string): Promise<{ type: 'ok' }> {
    const offline = (): {type: 'ok'} => {
      enqueue({ path: `/v1/chats/${encodeURIComponent(chatId)}`, method: 'DELETE' });
      return { type: 'ok' };
    };
    return offlineFallback(() => this.request<{ type: 'ok' }>(`/v1/chats/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    }), offline);
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
    regenerateMessageId?: string;
    suggestedTitle?: string;
    chatId: string;
    text: string;
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

  // OpenRouter key & model catalogue
  /** The masked key record, or null when no key is connected. */
  async getModelKey(): Promise<ModelKey | null> {
    try {
      return await this.request<ModelKey>('/v1/model-key');
    } catch (error) {
      if (error instanceof PraxisApiError && error.status === 404) return null;
      throw error;
    }
  }

  async connectModelKey(
    input: { method: 'paste'; apiKey: string } | { method: 'pkce'; code: string; codeVerifier: string },
  ): Promise<ModelKey> {
    return this.request<ModelKey>('/v1/model-key', {
      method: 'POST',
      body: JSON.stringify({ type: 'modelKey.connect', ...input }),
    });
  }

  async checkModelKey(): Promise<ModelKey> {
    return this.request<ModelKey>('/v1/model-key/check', { method: 'POST', body: '{}' });
  }

  async deleteModelKey(): Promise<{ type: 'ok' }> {
    return this.request<{ type: 'ok' }>('/v1/model-key', { method: 'DELETE' });
  }

  async listModels(params?: {
    q?: string;
    pinned?: boolean;
    favorite?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<PageResult<ModelListItem>> {
    const q = new URLSearchParams({ limit: String(params?.limit ?? 100) });
    if (params?.q) q.set('q', params.q);
    if (params?.pinned !== undefined) q.set('pinned', String(params.pinned));
    if (params?.favorite !== undefined) q.set('favorite', String(params.favorite));
    if (params?.cursor) q.set('cursor', params.cursor);
    return this.request<PageResult<ModelListItem>>(`/v1/models?${q.toString()}`);
  }

  async updateModelPreference(input: {
    modelId: string;
    pinned?: boolean;
    favorite?: boolean;
  }): Promise<ModelPreferenceRecord> {
    return this.request<ModelPreferenceRecord>('/v1/models/preferences', {
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
    vision?: { modelId?: string; enabled?: boolean };
    voice?: { model?: string; language?: string; apiKey?: string };
  }): Promise<Preferences> {
    return this.request<Preferences>('/v1/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ type: 'preferences.input', ...input }),
    });
  }

  // Delta Sync
  async syncPull(cursor = '0') {
    const raw = await this.request<unknown>(`/v1/sync/pull?cursor=${encodeURIComponent(cursor)}`);
    return SyncResponseSchema.parse(raw);
  }
}

export const apiClient = new PraxisApiClient();
