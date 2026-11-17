import {expect, it, vi} from 'vitest';
import {ToolBoundaryError} from '@praxis/agent';
import {symbolRanges} from './parser.js';
import {SYMBOL_PARSE_TIMEOUT_MS} from './constants.js';

it('enforces the deadline during collection after a successful parse', async () => {
  await symbolRanges('function warmup() {}', 'typescript');
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(SYMBOL_PARSE_TIMEOUT_MS);
  try {
    const error = await symbolRanges('function target() {}', 'typescript').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolBoundaryError);
    expect((error as ToolBoundaryError).detail.code).toBe('timeout');
  } finally {
    clock.mockRestore();
  }
});
