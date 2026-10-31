import type { ResolvedTheme, ThemeMode } from '@praxis/glass';
import type {
  Approval,
  Attachment,
  Capabilities,
  Chat,
  Connector,
  Message,
  Model,
  Provider,
  Run,
  Skill,
  Usage,
} from '@praxis/protocol';
import {
  type Consent,
  type Preferences,
  type Registry,
  type RegistryEntry,
  type ToolActivity,
  type ToolCompletion,
  type ToolSpec,
} from '../lib/api';

export interface ActiveToolStep {
  callId: string;
  activity: ToolActivity;
  argumentsJson: string;
  running: boolean;
  progressLines: string[];
  statusText?: string;
  completion?: ToolCompletion;
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
  textBlocks: Array<{ id: string; text: string; finished: boolean }>;
  reasoningBlocks: Array<{ id: string; text: string; finished: boolean }>;
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
  | null
  | 'history'
  | 'settings'
  | 'providers'
  | 'provider-editor'
  | 'connectors'
  | 'connector-add-url'
  | 'connector-paste-config'
  | 'connector-registry'
  | 'skills'
  | 'skill-import'
  | 'skill-browser'
  | 'image-reader'
  | 'voice-settings'
  | 'consents';

export interface PendingConsentPrompt {
  host: string;
  purpose: 'chat' | 'vision' | 'voice' | 'connector';
  description: string;
  onAllow: () => void;
  onCancel?: () => void;
}

export interface PraxisStoreContextValue {
  // Hydration & Perf
  hydrated: boolean;
  syncing: boolean;
  errorBanner: string | null;
  clearErrorBanner: () => void;

  // Theme
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setThemeMode: (mode: ThemeMode) => void;

  // Navigation & Sheets
  activeSheet: ActiveSheet;
  setActiveSheet: (sheet: ActiveSheet) => void;
  restoreRoute: (chatId: string | null, sheet: ActiveSheet, providerId?: string | null) => void;
  startNewConversation: () => void;
  editingProviderId: string | null;
  setEditingProviderId: (id: string | null) => void;
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
  providers: Provider[];
  models: Model[];
  connectors: Connector[];
  connectorTools: Record<string, ToolSpec[]>;
  skills: Skill[];
  registries: Registry[];
  registryEntries: Record<string, RegistryEntry[]>;
  consents: Consent[];
  preferences: Preferences | null;
  attachmentsById: Record<string, Attachment>;

  // Selected Composer Controls
  selectedProviderId: string;
  selectedModelId: string;
  webSearch: boolean;
  setWebSearch: (value: boolean) => void;
  cacheModels: (items: Model[]) => void;
  selectedEffort: string;
  selectedMode: 'ask' | 'plan' | 'build' | 'auto';
  setSelectedModel: (providerId: string, modelId: string) => void;
  setSelectedEffort: (effort: string) => void;
  setSelectedMode: (mode: 'ask' | 'plan' | 'build' | 'auto') => void;

  // Live Run State per Chat
  liveRunsByChat: Record<string, LiveRunState>;
  activeLiveRun: LiveRunState | null;

  // Consent Prompt
  pendingConsentPrompt: PendingConsentPrompt | null;
  setPendingConsentPrompt: (prompt: PendingConsentPrompt | null) => void;

  // Actions
  selectChat: (chatId: string) => Promise<void>;
  createNewChat: (title?: string) => Promise<Chat>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  togglePinChat: (chatId: string) => Promise<void>;
  deleteChats: (chatIds: string[]) => Promise<void>;
  toggleChatConnector: (chatId: string, connectorId: string, enabled: boolean) => Promise<void>;

  sendMessage: (
    text: string,
    options?: {
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
  ) => Promise<void>;
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

  toggleModelPin: (providerId: string, modelId: string, pinned: boolean) => Promise<void>;
  saveProvider: (input: {
    id?: string;
    name: string;
    flavor: 'anthropicMessages' | 'openAIChat' | 'openAIResponses';
    baseUrl: string;
    defaultModel?: string;
    apiKey?: string;
    capabilities?: Capabilities;
    extraHeaders?: Record<string, string>;
  }) => Promise<Provider>;
  removeProvider: (providerId: string) => Promise<void>;
  refreshModelsForProvider: (providerId: string) => Promise<Model[]>;

  createConnector: (input: {
    name: string;
    url: string;
    transport?: 'streamableHttp' | 'sse';
    token?: string;
    extraHeaders?: Record<string, string>;
  }) => Promise<Connector>;
  updateConnector: (
    connectorId: string,
    patch: {
      enabled?: boolean;
      trusted?: boolean;
      name?: string;
      url?: string;
    },
  ) => Promise<void>;
  removeConnector: (connectorId: string) => Promise<void>;
  loadConnectorTools: (connectorId: string) => Promise<ToolSpec[]>;
  setConnectorToolEnabled: (
    connectorId: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<void>;

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
    vision?: { providerId?: string; modelId?: string; enabled?: boolean };
    voice?: { model?: string; language?: string; apiKey?: string };
  }) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<Attachment[]>;
  transcribeAudioBlob: (blob: Blob) => Promise<string>;
  refreshAll: () => Promise<void>;
}
