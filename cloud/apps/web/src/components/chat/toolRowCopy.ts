import type { ActiveToolStep } from '../../state/store';

/** Keep the human action and its argument separate, including rehydrated calls. */
export function toolRowCopy(step: ActiveToolStep) {
  const raw = step.activity.name;
  const human = raw.replace(/[_./-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const presentation = step.running
    ? step.activity.presentation?.runningTitle
    : step.activity.presentation?.finishedTitle;
  const title = presentation && presentation !== raw ? presentation : human;
  let args = step.activity.arguments;
  try {
    args = JSON.parse(step.argumentsJson || '{}');
  } catch {
    /* incomplete streaming JSON */
  }
  const summary =
    args && typeof args === 'object'
      ? Object.values(args)
          .filter((v) => typeof v === 'string' || typeof v === 'number')
          .map(String)
          .join(' · ')
      : typeof args === 'string'
        ? args
        : '';
  return {
    title,
    summary: summary === raw || summary === title ? '' : summary.slice(0, 160),
  };
}
