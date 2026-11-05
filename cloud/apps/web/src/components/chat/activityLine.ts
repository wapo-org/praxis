import type { ActiveToolStep } from '../../state/types';

/** How long a run took, as iOS `DurationFormatter` writes it. Under a second never reads "0s". */
export function formatElapsed(milliseconds: number) {
  if (milliseconds < 1000) return '<1s';
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function elapsedLabel(startedAt?: string, finishedAt?: string) {
  if (!startedAt || !finishedAt) return null;
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) ? formatElapsed(Math.max(0, elapsed)) : null;
}

export function workedLabel(startedAt?: string, finishedAt?: string) {
  const elapsed = elapsedLabel(startedAt, finishedAt);
  return elapsed ? `Worked for ${elapsed}` : 'Worked';
}

export type ActivityPhase = 'running' | 'stopped' | 'finished';

/** The disclosure's label, matching iOS `ActivityData.label`. */
export function activityLabel(phase: ActivityPhase, startedAt?: string, finishedAt?: string) {
  if (phase === 'running') return 'Currently working…';
  if (phase === 'finished') return workedLabel(startedAt, finishedAt);
  const elapsed = elapsedLabel(startedAt, finishedAt);
  return elapsed ? `Stopped after ${elapsed}` : 'Stopped';
}

/** "local_echo" and "mcp__github__list_issues" read as "Local echo" and "List issues". */
export function humanizeToolName(name: string) {
  const last = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** Arguments that say what a call is about, most telling first. */
const KEY_ARGUMENTS = ['query', 'q', 'url', 'path', 'file_path', 'filePath', 'file', 'command', 'pattern', 'name', 'title', 'prompt', 'text'];

function parseArguments(step: ActiveToolStep): Record<string, unknown> | null {
  if (step.activity.arguments && typeof step.activity.arguments === 'object' && !Array.isArray(step.activity.arguments))
    return step.activity.arguments as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(step.argumentsJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function oneLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/** The call's key argument on one line, unless the title already says it. */
export function argumentSummary(step: ActiveToolStep, title: string) {
  const args = parseArguments(step);
  if (!args) return undefined;
  const keyed = KEY_ARGUMENTS.map((key) => args[key]).find((v) => typeof v === 'string' && v.trim());
  const value = keyed ?? Object.values(args).find((v) => typeof v === 'string' && v.trim());
  if (typeof value !== 'string') return undefined;
  const summary = oneLine(value);
  return title.toLowerCase().includes(summary.toLowerCase()) ? undefined : summary;
}

/** A human title: the API falls back to the raw tool name, which must never reach the row. */
export function stepTitle(step: ActiveToolStep) {
  const { name, presentation } = step.activity;
  const human = humanizeToolName(name);
  if (step.running) {
    const running = step.statusText || presentation?.runningTitle;
    return !running || running === name || running === `Running ${name}` ? `${human}…` : running;
  }
  const finished = presentation?.finishedTitle || step.completion?.summary;
  return !finished || finished === name || finished === 'Completed tool' ? human : finished;
}

export function stepSource(step: ActiveToolStep) {
  return step.activity.source?.serverName || undefined;
}

export function stepArguments(step: ActiveToolStep) {
  if (step.argumentsJson && step.argumentsJson !== '{}') {
    try {
      return JSON.stringify(JSON.parse(step.argumentsJson), null, 2);
    } catch {
      return step.argumentsJson;
    }
  }
  const { arguments: args } = step.activity;
  return args && Object.keys(args as object).length ? JSON.stringify(args, null, 2) : '';
}

/** Short trailing state for lines that ended badly, as iOS `Step.statusTag`. */
export function stepTag(step: ActiveToolStep): { text: string; danger: boolean } | undefined {
  switch (step.completion?.status) {
    case 'failed':
      return { text: 'Failed', danger: true };
    case 'denied':
      return { text: 'Declined', danger: false };
    case 'cancelled':
      return { text: 'Stopped', danger: false };
    default:
      return undefined;
  }
}

/** The quiet note under a turn that didn't simply finish, as iOS `TurnOutcome.note`.
 *  A stopped run has none: its activity line already reads "Stopped after 5s". */
export function outcomeNote(status?: string, outcome?: string, error?: string) {
  if (status === 'failed' || outcome === 'failed') return error ? `Couldn't finish: ${error}` : "Couldn't finish";
  if (outcome === 'truncated') return 'Cut off — the answer hit the output limit';
  if (outcome === 'maxIterations') return 'Paused — reached the step limit for this effort';
  if (outcome === 'refused') return 'Declined to answer';
  return null;
}
