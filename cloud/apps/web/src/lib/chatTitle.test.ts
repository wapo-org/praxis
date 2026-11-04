import { describe, expect, it } from 'vitest';
import { displayTitle } from './chatTitle';

describe('displayTitle', () => {
  it('leaves a title below the server cap alone', () => {
    expect(displayTitle('Plan the launch')).toBe('Plan the launch');
  });
  it('ends a capped title at a word with an ellipsis, not mid-word', () => {
    expect(displayTitle('Search the workspace with tools and summar')).toBe('Search the workspace with tools and…');
  });
  it('still marks one long unbroken word as cut', () => {
    expect(displayTitle('x'.repeat(42))).toBe(`${'x'.repeat(42)}…`);
  });
});
