import type { Capabilities, Provider, Skill } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../lib/api';

import type { PraxisState } from './usePraxisState';
export function useCatalogActions(state: PraxisState) {
  const {
    setErrorBanner,
    setChats,
    activeChatId,
    setProviders,
    setModels,
    setConnectors,
    setConnectorTools,
    setSkills,
    setRegistries,
    setRegistryEntries,
    setConsents,
    setPreferences,
    setSelectedProviderId,
    setSelectedModelId,
  } = state;
  const setSelectedModel = React.useCallback(
    (providerId: string, modelId: string) => {
      setSelectedProviderId(providerId);
      setSelectedModelId(modelId);
      if (activeChatId) {
        void apiClient
          .patchChat(activeChatId, { providerId, modelId })
          .then((updated) => {
            setChats((prev) => prev.map((c) => (c.id === activeChatId ? updated : c)));
          })
          .catch((err) =>
            setErrorBanner(err instanceof Error ? err.message : 'Unable to save model'),
          );
      }
    },
    [activeChatId],
  );

  const toggleModelPin = React.useCallback(
    async (providerId: string, modelId: string, pinned: boolean) => {
      try {
        const updated = await apiClient.updateModelPreference({
          providerId,
          modelId,
          pinned,
        });
        setModels((prev) =>
          prev.map((m) => (m.providerId === providerId && m.id === modelId ? updated : m)),
        );
      } catch (err) {
        setErrorBanner(err instanceof Error ? err.message : 'Request failed');
      }
    },
    [],
  );

  const saveProvider = React.useCallback(
    async (input: {
      id?: string;
      name: string;
      flavor: 'anthropicMessages' | 'openAIChat' | 'openAIResponses';
      baseUrl: string;
      defaultModel?: string;
      apiKey?: string;
      capabilities?: Capabilities;
      extraHeaders?: Record<string, string>;
    }): Promise<Provider> => {
      if (input.id) {
        const updated = await apiClient.patchProvider(input.id, input);
        setProviders((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        return updated;
      }
      const created = await apiClient.createProvider({
        ...input,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      });
      setProviders((prev) => [...prev, created]);
      return created;
    },
    [],
  );

  const removeProvider = React.useCallback(async (providerId: string) => {
    await apiClient.deleteProvider(providerId);
    setProviders((prev) => prev.filter((p) => p.id !== providerId));
  }, []);

  const refreshModelsForProvider = React.useCallback(async (providerId: string) => {
    const page = await apiClient.refreshProviderModels(providerId);
    setModels((prev) => {
      const others = prev.filter((m) => m.providerId !== providerId);
      return [...others, ...page.items];
    });
    return page.items;
  }, []);

  const createConnector = React.useCallback(
    async (input: {
      name: string;
      url: string;
      transport?: 'streamableHttp' | 'sse';
      token?: string;
    }) => {
      const created = await apiClient.createConnector(input);
      setConnectors((prev) => [...prev, created]);
      return created;
    },
    [],
  );

  const updateConnector = React.useCallback(
    async (
      connectorId: string,
      patch: {
        enabled?: boolean;
        trusted?: boolean;
        name?: string;
        url?: string;
      },
    ) => {
      const updated = await apiClient.patchConnector(connectorId, patch);
      setConnectors((prev) => prev.map((c) => (c.id === connectorId ? updated : c)));
    },
    [],
  );

  const removeConnector = React.useCallback(async (connectorId: string) => {
    await apiClient.deleteConnector(connectorId);
    setConnectors((prev) => prev.filter((c) => c.id !== connectorId));
  }, []);

  const loadConnectorTools = React.useCallback(async (connectorId: string) => {
    const page = await apiClient.listConnectorTools(connectorId);
    setConnectorTools((prev) => ({ ...prev, [connectorId]: page.items }));
    return page.items;
  }, []);

  const setConnectorToolEnabled = React.useCallback(
    async (connectorId: string, toolName: string, enabled: boolean) => {
      const updated = await apiClient.toggleConnectorTool(connectorId, toolName, enabled);
      setConnectors((prev) => prev.map((c) => (c.id === connectorId ? updated : c)));
    },
    [],
  );

  const saveSkill = React.useCallback(
    async (input: {
      id?: string;
      name: string;
      description: string;
      document: string;
      enabled?: boolean;
    }): Promise<Skill> => {
      if (input.id) {
        const updated = await apiClient.patchSkill(input.id, input);
        setSkills((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        return updated;
      }
      const created = await apiClient.createSkill(input);
      setSkills((prev) => [...prev, created]);
      return created;
    },
    [],
  );

  const removeSkill = React.useCallback(async (skillId: string) => {
    await apiClient.deleteSkill(skillId);
    setSkills((prev) => prev.filter((s) => s.id !== skillId));
  }, []);

  const addSkillRegistry = React.useCallback(async (name: string, url: string) => {
    const created = await apiClient.createSkillRegistry({
      name,
      url,
      enabled: true,
    });
    setRegistries((prev) => [...prev, created]);
    return created;
  }, []);

  const removeSkillRegistry = React.useCallback(async (registryId: string) => {
    await apiClient.deleteSkillRegistry(registryId);
    setRegistries((prev) => prev.filter((r) => r.id !== registryId));
  }, []);

  const searchRegistry = React.useCallback(async (registryId: string, q = '') => {
    const page = await apiClient.searchSkillRegistry(registryId, q);
    setRegistryEntries((prev) => ({ ...prev, [registryId]: page.items }));
    return page.items;
  }, []);

  const installSkillFromRegistry = React.useCallback(
    async (registryId: string, skillEntryId: string) => {
      const installed = await apiClient.installRegistrySkill(registryId, skillEntryId);
      setSkills((prev) => [...prev.filter((s) => s.id !== installed.id), installed]);
      return installed;
    },
    [],
  );

  const grantConsent = React.useCallback(async (host: string, allowed: boolean) => {
    const updated = await apiClient.setConsent(host, allowed);
    setConsents((prev) => [...prev.filter((c) => c.host !== updated.host), updated]);
  }, []);

  const updatePreferences = React.useCallback(
    async (input: {
      vision?: { providerId?: string; modelId?: string; enabled?: boolean };
      voice?: { model?: string; language?: string; apiKey?: string };
    }) => {
      const updated = await apiClient.patchPreferences(input);
      setPreferences(updated);
    },
    [],
  );

  return {
    setSelectedModel,
    toggleModelPin,
    saveProvider,
    removeProvider,
    refreshModelsForProvider,
    createConnector,
    updateConnector,
    removeConnector,
    loadConnectorTools,
    setConnectorToolEnabled,
    saveSkill,
    removeSkill,
    addSkillRegistry,
    removeSkillRegistry,
    searchRegistry,
    installSkillFromRegistry,
    grantConsent,
    updatePreferences,
  };
}
