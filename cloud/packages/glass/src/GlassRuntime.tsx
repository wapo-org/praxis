import React from 'react';
import { negotiateStrategy, type MaterialLevel } from './engine-detect';
import { useGlassRuntime, GlassMaterialContext } from './glass-store';
import { GlassFilters } from './GlassFilters';

export function GlassRuntime({
  children,
  level = 'regular',
}: {
  children: React.ReactNode;
  level?: MaterialLevel;
}) {
  const strategy = useGlassRuntime((s) => s.strategy);
  const setStrategy = useGlassRuntime((s) => s.setStrategy);
  const overrides = useGlassRuntime((s) => s.overrides);
  const setOverrides = useGlassRuntime((s) => s.setOverrides);

  React.useEffect(() => {
    const update = () => setStrategy(negotiateStrategy());
    update();
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mql = window.matchMedia('(prefers-reduced-transparency: reduce)');
      mql.addEventListener?.('change', update);
      return () => mql.removeEventListener?.('change', update);
    }
    return undefined;
  }, [setStrategy]);

  const value = React.useMemo(
    () => ({ strategy, level, overrides, setOverrides }),
    [strategy, level, overrides, setOverrides],
  );

  return (
    <GlassMaterialContext.Provider value={value}>
      {children}
      <GlassFilters />
    </GlassMaterialContext.Provider>
  );
}

export const GlassMaterialProvider = GlassRuntime;
