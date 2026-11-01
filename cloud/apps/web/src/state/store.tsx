import React from 'react';
import { PraxisStoreContext } from './context';
import type { PraxisStoreContextValue } from './types';
import { useCatalogActions } from './useCatalogActions';
import { useChatActions } from './useChatActions';
import { useConsent } from './useConsent';
import { useMediaActions } from './useMediaActions';
import { usePraxisState } from './usePraxisState';
import { useLiveFollower } from './useLiveFollower';
import { useReplica } from './useReplica';
import { useRunState } from './useRunState';
import { useRunStreams } from './useRunStreams';
import { useSendActions } from './useSendActions';
export { usePraxisStore } from './context';
export * from './types';
export function PraxisStoreProvider({
  children,
  onNavigate,
}: {
  children: React.ReactNode;
  onNavigate?: (path: string) => void;
}) {
  const state = usePraxisState(onNavigate);
  const runState = useRunState(state);
  const streams = useRunStreams(state, runState);
  const replica = useReplica(state, { ...streams, ...runState });
  useLiveFollower(state, { ...streams, ...runState });
  const chats = useChatActions(state, replica);
  const send = useSendActions(state, { ...chats, ...streams });
  const consent = useConsent(state, send);
  const catalog = useCatalogActions(state);
  const media = useMediaActions(state);
  const activeChat = React.useMemo(
    () => state.chats.find((chat) => chat.id === state.activeChatId) ?? null,
    [state.chats, state.activeChatId],
  );
  const activeMessages = React.useMemo(
    () => (state.activeChatId ? (state.messagesByChat[state.activeChatId] ?? []) : []),
    [state.activeChatId, state.messagesByChat],
  );
  const activeLiveRun = React.useMemo(
    () => (state.activeChatId ? (state.liveRunsByChat[state.activeChatId] ?? null) : null),
    [state.activeChatId, state.liveRunsByChat],
  );
  const value: PraxisStoreContextValue = {
    ...state,
    ...chats,
    ...send,
    ...consent,
    ...catalog,
    ...media,
    activeChat,
    activeMessages,
    activeLiveRun,
    refreshAll: replica.refreshAll,
    clearErrorBanner: () => state.setErrorBanner(null),
  };
  return <PraxisStoreContext.Provider value={value}>{children}</PraxisStoreContext.Provider>;
}
