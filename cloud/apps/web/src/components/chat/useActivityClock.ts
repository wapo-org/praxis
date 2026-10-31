import React from 'react';
export function workedLabel(startedAt?: string, finishedAt?: string) {
  if (!startedAt || !finishedAt) return 'Worked';
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) ? `Worked for ${Math.max(0, Math.round(elapsed / 1000))}s` : 'Worked';
}
export function useActivityClock(running: boolean, startedAt?: string, finishedAt?: string) {
  const [now, setNow] = React.useState(() => new Date().toISOString());
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return workedLabel(startedAt, running ? now : finishedAt);
}
