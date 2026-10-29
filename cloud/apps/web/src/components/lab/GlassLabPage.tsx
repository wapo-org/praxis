import React from 'react';

export function GlassLabPage({ onNavigateBack }: { onNavigateBack?: () => void }) {
  return <div data-testid="glass-lab-placeholder" onClick={onNavigateBack} />;
}
