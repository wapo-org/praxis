import React from 'react';
import type { PraxisStoreContextValue } from './types';
export const PraxisStoreContext = React.createContext<PraxisStoreContextValue | null>(null);

export function usePraxisStore(): PraxisStoreContextValue {
  const ctx = React.useContext(PraxisStoreContext);
  if (!ctx) {
    throw new Error('usePraxisStore must be used within <PraxisStoreProvider>');
  }
  return ctx;
}
