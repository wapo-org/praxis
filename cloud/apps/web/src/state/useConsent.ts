import React from 'react';
import { apiClient } from '../lib/api';

import type { PraxisState } from './usePraxisState';
import type { useSendActions } from './useSendActions';
export function useConsent(
  state: PraxisState,
  { executeSendMessage }: Pick<ReturnType<typeof useSendActions>, 'executeSendMessage'>,
) {
  const {
    setErrorBanner,
    providers,
    consents,
    setConsents,
    selectedProviderId,
    setPendingConsentPrompt,
  } = state;
  const sendMessage = React.useCallback(
    async (
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
    ) => {
      // Check if selected provider is a non-local external host that needs consent
      const provider = providers.find((p) => p.id === selectedProviderId);
      if (provider && provider.id !== 'scripted') {
        try {
          const endpoint = new URL(provider.baseUrl);
          if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname)
            throw new Error('Invalid provider URL');
          const host = endpoint.hostname.toLowerCase();
          const hasConsent = consents.some((c) => c.host.toLowerCase() === host && c.allowed);
          if (!hasConsent) {
            setPendingConsentPrompt({
              host,
              purpose: 'chat',
              description: `Allow Praxis to send conversation messages and attachments to ${provider.name} (${host})?`,
              onAllow: () => {
                void apiClient
                  .setConsent(host, true)
                  .then((c) => {
                    setConsents((prev) => [...prev.filter((x) => x.host !== c.host), c]);
                    setPendingConsentPrompt(null);
                    void executeSendMessage(text, options);
                  })
                  .catch((error) =>
                    setErrorBanner(
                      error instanceof Error ? error.message : 'Unable to save consent',
                    ),
                  );
              },
              onCancel: () => setPendingConsentPrompt(null),
            });
            return;
          }
        } catch {
          setErrorBanner(
            'This provider has an invalid server URL. Update it in Settings before sending.',
          );
          return;
        }
      }
      await executeSendMessage(text, options);
    },
    [providers, selectedProviderId, consents, executeSendMessage],
  );

  return { sendMessage };
}
