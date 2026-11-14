import { toolDisplay } from './toolDisplay';
import type { ActiveToolStep } from '../../state/store';

/** Keep the human action and its argument separate, including rehydrated calls. */
export function toolRowCopy(step: ActiveToolStep) {
  const display = toolDisplay(step);
  return { title: display.title, summary: display.detail };
}
