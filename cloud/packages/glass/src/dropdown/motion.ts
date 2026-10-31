import React from 'react';
const query = '(prefers-reduced-motion: reduce)';
function subscribe(update: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener('change', update);
  return () => media.removeEventListener('change', update);
}
export function useMenuReducedMotion() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
