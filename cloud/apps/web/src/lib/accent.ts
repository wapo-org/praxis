import { useSyncExternalStore } from 'react';
export const ACCENTS = ['neutral', 'blue', 'violet', 'rose', 'amber', 'green'] as const;
export type Accent = (typeof ACCENTS)[number];
export const isAccent = (value: unknown): value is Accent => ACCENTS.includes(value as Accent);
export function readAccent(): Accent {
  if (typeof document === 'undefined') return 'neutral';
  const value = document.documentElement.dataset.accent;
  return isAccent(value) ? value : 'neutral';
}
export function setAccent(value: Accent) {
  document.documentElement.dataset.accent = value;
  try {
    localStorage.setItem('praxis-accent', value);
  } catch {
    /* The current session still works with storage denied. */
  }
  window.dispatchEvent(new Event('praxis:accent'));
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== 'praxis-accent' && event.key !== null) return;
    document.documentElement.dataset.accent = isAccent(event.newValue) ? event.newValue : 'neutral';
    notify();
  };
  window.addEventListener('praxis:accent', notify);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener('praxis:accent', notify);
    window.removeEventListener('storage', storage);
  };
}
export const useAccent = () =>
  useSyncExternalStore(subscribe, readAccent, () => 'neutral' as Accent);
