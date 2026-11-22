import { effortsFor } from '../lib/models';
import type { Chat, ModelListItem as Model } from '@praxis/protocol';
import type { PraxisStoreContextValue as Store } from '../state/types';
import { isMode, MODE_LABELS, MODES } from '../lib/modes';
import { Camera, Copy, Edit, Folder, Globe, LayoutGrid, Photo, Pin, Settings, Sliders, Sparkles, Trash2 } from '../lib/icons';

export const ATTACHMENTS = [
  { name: 'Photos', Icon: Photo, accept: 'image/*', capture: undefined },
  { name: 'Camera', Icon: Camera, accept: 'image/*', capture: true },
  { name: 'Files', Icon: Folder, accept: '*/*', capture: undefined },
  { name: 'Screenshot', Icon: Copy, accept: 'image/*', capture: undefined },
] as const;
export interface ActionOption { id: string; label: string; selected: boolean; model?: Model }
interface Action {
  label: string; Icon: typeof Edit; available: (s: Store) => boolean;
  options?: (s: Store, models: readonly Model[]) => ActionOption[];
  apply: (s: Store, id?: string, models?: readonly Model[]) => void | Promise<void>;
}
const selectedModel = (s: Store) => s.models.find(m => m.id === s.selectedModelId);
const displayLabel = (id: string) => id.slice(0, 1).toUpperCase() + id.slice(1);
export const ACTIONS = {
  model: { label: 'Change model', Icon: Sparkles, available: () => true,
    options: (s, models) => models.map(model => ({ id: model.id, label: model.name,
      selected: model.id === s.selectedModelId, model })),
    apply: (s, id, models = s.models) => { const m = models.find(m => m.id === id); if (m) { s.cacheModels([m]); s.setSelectedModel(m.id); } } },
  effort: { label: 'Change reasoning level', Icon: Sliders, available: s => !!effortsFor(selectedModel(s)).length,
    options: s => (effortsFor(selectedModel(s)) ?? []).map(id => ({ id, label: displayLabel(id), selected: s.selectedEffort === id })),
    apply: (s, id) => { if (id && effortsFor(selectedModel(s)).includes(id)) s.setSelectedEffort(id); } },
  mode: { label: 'Change mode', Icon: Sliders, available: () => true,
    // Auto, Ask, Execute (WP-I1). Execute is what Build was; Plan is gone (lib/modes.ts has the wire mapping).
    options: s => MODES.map(id => ({ id, label: MODE_LABELS[id], selected: s.selectedMode === id })),
    apply: (s, id) => { if (isMode(id)) s.setSelectedMode(id); } },
  newChat: { label: 'New chat', Icon: Edit, available: () => true, apply: s => s.startNewConversation() },
  web: { label: 'Web tools', Icon: Globe, available: s => !!s.activeChat,
    apply: s => s.activeChat ? s.setChatWebTools(s.activeChat.id, s.activeChat.webToolsEnabled === false) : undefined },
  apps: { label: 'App Directory', Icon: LayoutGrid, available: () => true, apply: s => s.setActiveSheet('apps') },
  providers: { label: 'Models & OpenRouter', Icon: Settings, available: () => true, apply: s => s.setActiveSheet('models') },
  pin: { label: 'Pin chat', Icon: Pin, available: s => !!s.activeChat, apply: s => s.activeChat ? s.togglePinChat(s.activeChat.id) : undefined },
  delete: { label: 'Delete chat', Icon: Trash2, available: s => !!s.activeChat, apply: s => s.activeChat ? s.deleteChats([s.activeChat.id]) : undefined },
} satisfies Record<string, Action>;
export type ActionId = keyof typeof ACTIONS;
export function actionOptions(id: ActionId, store: Store, models: readonly Model[] = store.models): ActionOption[] {
  return (ACTIONS[id] as Action).options?.(store, models) ?? [];
}
export function applyOption(id: ActionId, store: Store, option: string, models?: readonly Model[]) {
  return (ACTIONS[id] as Action).apply(store, option, models);
}
export function chatActions(store: Store, chat: Chat, rename: () => void) {
  return [
    { id: 'pin', label: chat.pinned ? 'Unpin' : 'Pin', Icon: ACTIONS.pin.Icon, apply: () => store.togglePinChat(chat.id) },
    { id: 'rename', label: 'Rename', Icon: Edit, apply: rename },
    { id: 'delete', label: ACTIONS.delete.label.replace(' chat', ''), Icon: ACTIONS.delete.Icon, apply: () => store.deleteChats([chat.id]) },
  ];
}
