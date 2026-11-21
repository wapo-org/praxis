import React from 'react';
import { isScriptedModel } from '../lib/models';

import type { PraxisState } from './usePraxisState';
import type { useSendActions } from './useSendActions';

type SendOptions = Parameters<ReturnType<typeof useSendActions>['executeSendMessage']>[1];

/** With no OpenRouter key, sending opens the connect card instead of starting a run that can only fail. */
export function useSendGate(
  state: PraxisState,
  { executeSendMessage }: Pick<ReturnType<typeof useSendActions>, 'executeSendMessage'>,
) {
  const { modelKey, selectedModelId, hydrated, setActiveSheet } = state;
  const sendMessage = React.useCallback(
    async (text: string, options?: SendOptions): Promise<boolean> => {
      // Before the first load the key is unknown; the server decides then (and answers model_key_missing).
      if (hydrated && !modelKey && !isScriptedModel(selectedModelId) && !options?.script) {
        setActiveSheet('models');
        return false;
      }
      return executeSendMessage(text, options);
    },
    [modelKey, selectedModelId, hydrated, executeSendMessage, setActiveSheet],
  );

  return { sendMessage };
}
