import { describe, expect, it } from 'vitest';
import { toolRowCopy } from './toolRowCopy';
import type { ActiveToolStep } from '../../state/store';
const step = (argumentsJson: string, finishedTitle = 'local_echo') =>
  ({
    activity: { name: 'local_echo', presentation: { finishedTitle } },
    argumentsJson,
    running: false,
  }) as ActiveToolStep;
describe('tool row copy', () => {
  it('does not repeat rehydrated tool names and summarizes arguments', () => {
    expect(toolRowCopy(step('{"text":"hello"}'))).toEqual({
      title: 'Local echo',
      summary: 'hello',
    });
    expect(toolRowCopy(step('{}'))).toEqual({
      title: 'Local echo',
      summary: '',
    });
    expect(toolRowCopy(step('{"text":"local_echo"}')).summary).toBe('');
  });
  it('retains provider human titles and tolerates incomplete streamed JSON', () => {
    expect(toolRowCopy(step('{', 'Read the project')).title).toBe('Read the project');
    expect(toolRowCopy(step('{')).summary).toBe('');
  });
});
