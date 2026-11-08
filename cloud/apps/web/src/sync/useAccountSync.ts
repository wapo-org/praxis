import React from 'react';
import { ChatSchema, MessageSchema, SyncResponseSchema } from '@praxis/protocol';
import { apiClient } from '../lib/api';
import { applySidebarLook, useSidebarPalette, useButtonColor } from '../lib/sidebarPalette';
import { enqueue, flushEdits, pendingEdits } from './outbox';
import type { PraxisState } from '../state/usePraxisState';

/** Account preferences use one durable row per field: unrelated concurrent edits never overwrite each other. */
export function useAccountSync(state: PraxisState) {
  const latest = React.useRef(state); latest.current = state;
  const palette = useSidebarPalette(); const button = useButtonColor();
  const values = { theme: state.themeMode, palette, button, model: state.selectedModelId, provider: state.selectedProviderId, effort: state.selectedEffort };
  const caughtUp = React.useRef(false);
  const previous = React.useRef(values);
  const remote = React.useRef<Record<string, string>>({});
  React.useEffect(() => {
    for (const [field, value] of Object.entries(values)) {
      if (state.replicaKey.current && caughtUp.current && value !== previous.current[field as keyof typeof values] && remote.current[field] !== value) {
        enqueue({ path: '/v1/sync/settings', method: 'PATCH', body: JSON.stringify({ field, value }) });
      }
    }
    previous.current = values;
    void flushEdits();
  }, [values.theme, palette, button, values.model, values.provider, values.effort]);
  React.useEffect(() => {
    if (!state.replicaKey.current) return;
    let stopped = false;
    const controller = new AbortController();
    let cursor = '0'; // Replay durable settings and repair all entities, not just retained user-channel events.
    const apply = (raw: unknown) => {
      const page = SyncResponseSchema.parse(raw);
      const s = latest.current;
      for (const entity of page.entities) {
        const [kind, ...parts] = entity.key.split(':'); const id = parts.join(':');
        const pending = pendingEdits();
        if (kind === 'chat') {
          if (pending.some(e => e.path === `/v1/chats/${encodeURIComponent(id)}`)) continue;
          if (entity.deleted) { s.setChats(prev => prev.filter(c => c.id !== id)); s.setMessagesByChat(prev => { const next = { ...prev }; delete next[id]; return next; }); }
          else { const chat = ChatSchema.parse(entity.value); s.setChats(prev => [...prev.filter(c => c.id !== id), chat].sort((a,b) => Number(b.pinned)-Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))); }
        }
        if (kind === 'message') {
          if (entity.deleted) s.setMessagesByChat(prev => Object.fromEntries(Object.entries(prev).map(([chat, messages]) => [chat, messages.filter(m => m.id !== id)])));
          else { const message = MessageSchema.parse(entity.value); s.setMessagesByChat(prev => ({ ...prev, [message.chatId]: [...(prev[message.chatId] ?? []).filter(m => m.id !== id), message].sort((a,b) => a.createdAt.localeCompare(b.createdAt)) })); }
        }
        if (kind === 'accountSetting' && !entity.deleted) {
          const { field, value } = entity.value as { field: string; value: string };
          if (pending.some(e => e.path === '/v1/sync/settings' && JSON.parse(e.body!).field === field)) continue;
          remote.current[field] = value;
          if (field === 'theme' && ['light','dark','system'].includes(value)) s.setThemeMode(value as 'light'|'dark'|'system');
          if (field === 'palette' || field === 'button') {
            const root = document.documentElement;
            applySidebarLook(field === 'palette' ? value : root.dataset.sidebarPalette, field === 'button' ? value : root.dataset.buttonColor);
            localStorage.setItem(field === 'palette' ? 'praxis-sidebar-palette' : 'praxis-button-color', value);
            window.dispatchEvent(new Event('praxis:sidebar-look'));
          }
          if (field === 'model') s.setSelectedModelId(value);
          if (field === 'provider') s.setSelectedProviderId(value);
          if (field === 'effort') s.setSelectedEffort(value);
        }
      }
      cursor = page.cursor; s.setSyncCursor(cursor);
      if (!page.nextCursor) caughtUp.current = true;
    };
    async function loop() {
      while (!stopped) {
        try {
          await flushEdits();
          const token = apiClient.getBearerToken();
          const response = await fetch(`${apiClient.getBaseUrl()}/v1/sync/events?cursor=${cursor}`, { credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
          if (response.status === 401) { apiClient.onUnauthorized?.(); return; }
          if (!response.ok || !response.body) throw Error('Sync unavailable');
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
          while (!stopped) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
              const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
              if (data) apply(JSON.parse(data));
            }
          }
        } catch { if (stopped) return; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    const online = () => { void flushEdits(); };
    window.addEventListener('online', online);
    void loop();
    return () => { stopped = true; controller.abort(); window.removeEventListener('online', online); };
  }, []);
}
