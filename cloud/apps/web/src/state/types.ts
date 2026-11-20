import type { Mode } from '../lib/modes';
import type { ResolvedTheme, ThemeMode } from '@praxis/glass';
import type {
  Approval,
  Attachment,
  Chat,
  Message,
  Run,
  Skill,
  Usage,
  ModelKey,
  ModelListItem,
} from '@praxis/protocol';
import {
  type Consent,
  type Preferences,
  type Registry,
  type RegistryEntry,
  type ToolActivity,
  type ToolCompletion,
} from '../lib/api';

export interface ActiveToolStep {
  callId: string;
  activity: ToolActivity;
  argumentsJson: string;
  running: boolean;
  progressLines: string[];
  statusText?: string;
  completion?: ToolCompletion;
  startedAt?: string;
  finishedAt?: string;
  timelineOrder?: number;
}

export interface ActiveElicitation {
  id: string;
  message: string;
  schema: Record<string, unknown>;
  callId?: string;
  connectorId?: string;
  connectorName?: string;
  mode?: 'form' | 'url';
  url?: string;
}

export interface LiveRunState {
  run: Run;
  lastEventId: number;
  textBlocks: Array<{ id: string; text: string; finished: boolean; timelineOrder?: number }>;
  reasoningBlocks: import('../components/chat/ReasoningView').ReasoningBlock[];
  toolSteps: ActiveToolStep[];
  pendingApprovals: Approval[];
  pendingElicitations: ActiveElicitation[];
  visionActivities: Array<{
    id: string;
    phase: 'started' | 'finished' | 'failed';
    attachmentId: string;
    modelId?: string;
    question?: string;
    answer?: string;
  }>;
  compactions: Array<{
    id: string;
    phase: 'started' | 'finished' | 'failed';
    summary?: string;
  }>;
  usage?: Usage;
}

export type ActiveSheet =
  | 'general'
  | 'account'
  | 'developer'
  | null
  | 'history'
  | 'settings'
  | 'models'
  | 'openrouter-callback'
  | 'apps'
  | 'app-connected'
  | 'skills'
  | 'skill-import'
  | 'skill-browser'
  | 'image-reader'
  | 'voice-settings'
  | 'consents'
  | 'saved-values';

export interface PendingConsentPrompt {
  host: string;
  purpose: 'chat' | 'vision' | 'voice' | 'connector';
  description: string;
  onAllow: () => void;
  onCancel?: () => void;
}

export interface PraxisStoreContextValue {
  draftTitle: string;
  pendingChatSwitchRef: React.RefObject<string | null>;
  // Hydration & Perf
  hydrated: boolean;
  syncing: boolean;
  errorBanner: string | null;
  clearErrorBanner: () => void;
  /** Shows a failure in the app's error banner (for work that finishes after its surface has closed). */
  reportError: (message: string) => void;

  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setThemeMode: (mode: ThemeMode) => void;

  // Navigation & Sheets
  activeSheet: ActiveSheet;
  setActiveSheet: (sheet: ActiveSheet) => void;
  restoreRoute: (chatId: string | null, sheet: ActiveSheet) => void;
  startNewConversation: () => void;
  desktopSidebarOpen: boolean;
  setDesktopSidebarOpen: (open: boolean) => void;
  plusTrayOpen: boolean;
  setPlusTrayOpen: (open: boolean) => void;
  inlineModelSearchActive: boolean;
  setInlineModelSearchActive: (active: boolean) => void;

  // Core Entities
  chats: Chat[];
  activeChatId: string | null;
  activeChat: Chat | null;
  messagesByChat: Record<string, Message[]>;
  activeMessages: Message[];
  /** The user's OpenRouter key as the server shows it (masked); null when none is connected. */
  modelKey: ModelKey | null;
  /** OpenRouter catalogue entries seen so far: the first page plus any model this client selected. */
  models: ModelListItem[];
  skills: Skill[];
  registries: Registry[];
  registryEntries: Record<string, RegistryEntry[]>;
  consents: Consent[];
  preferences: Preferences | null;
  attachmentsById: Record<string, Attachment>;

  // Selected Composer Controls
  selectedModelId: string;
  cacheModels: (items: ModelListItem[]) => void;
  selectedEffort: string;
  selectedMode: Mode;
  setSelectedModel: (modelId: string) => void;
  setSelectedEffort: (effort: string) => void;
  setSelectedMode: (mode: import('../lib/modes').Mode) => void;

  // Live Run State per Chat
  liveRunsByChat: Record<string, LiveRunState>;
  activeLiveRun: LiveRunState | null;

  pendingConsentPrompt: PendingConsentPrompt | null;
  setPendingConsentPrompt: (prompt: PendingConsentPrompt | null) => void;

  // Actions
  selectChat: (chatId: string) => Promise<void>;
  createNewChat: (title?: string, id?: string) => Promise<Chat>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  togglePinChat: (chatId: string) => Promise<void>;
  deleteChats: (chatIds: string[]) => Promise<void>;
  /** Turns one App Directory app on or off for a chat (`composio:<toolkit>` connector ids). */
  setChatApp: (chatId: string, toolkit: string, enabled: boolean) => Promise<void>;
  setChatWebTools: (chatId: string, enabled: boolean) => Promise<void>;

  /** Resolves false when the connect card opened instead (no OpenRouter key); the caller keeps the draft. */
  sendMessage: (
    text: string,
    options?: {
      regenerateMessageId?: string;
        attachmentIds?: string[];
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
    },
  ) => Promise<boolean>;
  cancelActiveRun: () => Promise<void>;
  resolveApproval: (
    runId: string,
    approvalId: string,
    decision: 'allowOnce' | 'allowAlways' | 'deny',
  ) => Promise<void>;
  resolveElicitation: (
    runId: string,
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => Promise<void>;

  toggleModelPin: (modelId: string, pinned: boolean) => Promise<void>;
  connectModelKey: (
    input: { method: 'paste'; apiKey: string } | { method: 'pkce'; code: string; codeVerifier: string },
  ) => Promise<ModelKey>;
  checkModelKey: () => Promise<ModelKey>;
  disconnectModelKey: () => Promise<void>;

  saveSkill: (input: {
    id?: string;
    name: string;
    description: string;
    document: string;
    enabled?: boolean;
  }) => Promise<Skill>;
  removeSkill: (skillId: string) => Promise<void>;
  addSkillRegistry: (name: string, url: string) => Promise<Registry>;
  removeSkillRegistry: (registryId: string) => Promise<void>;
  searchRegistry: (registryId: string, q?: string) => Promise<RegistryEntry[]>;
  installSkillFromRegistry: (registryId: string, skillEntryId: string) => Promise<Skill>;

  grantConsent: (host: string, allowed: boolean) => Promise<void>;
  updatePreferences: (input: {
    vision?: { modelId?: string; enabled?: boolean };
    voice?: { model?: string; language?: string; apiKey?: string };
  }) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<Attachment[]>;
  transcribeAudioBlob: (blob: Blob) => Promise<string>;
  refreshAll: () => Promise<void>;
}
