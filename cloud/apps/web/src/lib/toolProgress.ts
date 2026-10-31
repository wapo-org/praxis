import type { RunSnapshot } from '@praxis/protocol';
export function snapshotProgress(tool: Pick<RunSnapshot['tools'][number], 'progress'>) {
  const text = (p: Record<string, unknown>) =>
    typeof p.text === 'string'
      ? p.text
      : Array.isArray(p.lines)
        ? p.lines.filter((v): v is string => typeof v === 'string').join(' ')
        : undefined;
  const lines = tool.progress.flatMap((p) => (text(p) ? [text(p)!] : []));
  const status = [...tool.progress].reverse().find((p) => p.kind === 'status' && !!text(p));
  return {
    progressLines: lines,
    statusText: status ? text(status) : undefined,
  };
}
