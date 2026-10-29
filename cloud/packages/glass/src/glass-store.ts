import React from 'react';
import {
  negotiateStrategy,
  type GlassStrategy,
  type MaterialLevel,
  type RefractionIntensity,
  type GlassFinish,
} from './engine-detect';

export interface FilterSpec {
  id: string;
  width: number;
  height: number;
  displacementUrl: string;
  specularUrl: string;
  scale: number;
  specularOpacity: number;
  saturate: number;
}

export interface GlassMaterialControls {
  material?: MaterialLevel;
  intensity?: RefractionIntensity;
  refraction?: boolean;
  frost?: 'progressive' | 'uniform' | 'none';
  finish?: GlassFinish;
  backdrop?: 'auto' | 'svg' | 'frost';
  stretchable?: boolean;
  bounce?: boolean;
  spotlight?: boolean;
}

export interface GlassMaterialContextValue {
  strategy: GlassStrategy;
  level: MaterialLevel;
  overrides: GlassMaterialControls;
  setOverrides: (next: Partial<GlassMaterialControls>) => void;
}

export const GlassMaterialContext = React.createContext<GlassMaterialContextValue>({
  strategy: 'progressive-frost',
  level: 'regular',
  overrides: {},
  setOverrides: () => {},
});

export function useGlassMaterial(): GlassMaterialContextValue {
  return React.useContext(GlassMaterialContext);
}

type Listener = () => void;

interface GlassStoreState {
  strategy: GlassStrategy;
  filters: Record<string, FilterSpec>;
  overrides: GlassMaterialControls;
  setStrategy: (strategy: GlassStrategy) => void;
  registerFilter: (id: string, spec: FilterSpec) => void;
  unregisterFilter: (id: string) => void;
  setOverrides: (next: Partial<GlassMaterialControls>) => void;
}

const listeners = new Set<Listener>();

let state: GlassStoreState = {
  strategy: typeof window !== 'undefined' ? negotiateStrategy() : 'progressive-frost',
  filters: {},
  overrides: {},
  setStrategy(strategy: GlassStrategy) {
    if (state.strategy === strategy) return;
    state = { ...state, strategy };
    listeners.forEach((l) => l());
  },
  registerFilter(id: string, spec: FilterSpec) {
    const prev = state.filters[id];
    if (
      prev &&
      prev.width === spec.width &&
      prev.height === spec.height &&
      prev.displacementUrl === spec.displacementUrl &&
      Math.abs(prev.scale - spec.scale) < 0.25 &&
      prev.specularOpacity === spec.specularOpacity &&
      prev.saturate === spec.saturate
    ) {
      return;
    }
    state = {
      ...state,
      filters: { ...state.filters, [id]: spec },
    };
    listeners.forEach((l) => l());
  },
  unregisterFilter(id: string) {
    if (!(id in state.filters)) return;
    const nextFilters = { ...state.filters };
    delete nextFilters[id];
    state = { ...state, filters: nextFilters };
    listeners.forEach((l) => l());
  },
  setOverrides(next: Partial<GlassMaterialControls>) {
    state = { ...state, overrides: { ...state.overrides, ...next } };
    listeners.forEach((l) => l());
  },
};

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGlassRuntime<T>(selector: (s: GlassStoreState) => T): T {
  return React.useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function useGlassOverrides(): GlassMaterialControls {
  return useGlassRuntime((s) => s.overrides);
}
