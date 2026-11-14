import { describe, expect, it } from 'vitest';
import { displayTitle, normalizeTitle } from './chatTitle';

describe('normalizeTitle', () => {
  it('collapses newlines, tabs, and repeated whitespace to single spaces', () => {
    expect(normalizeTitle('  Hello\nHello\r\nHello  ')).toBe('Hello Hello Hello');
    expect(normalizeTitle('Here are a few options:\n\n*\tChat: Longer Re')).toBe('Here are a few options: * Chat: Longer Re');
  });
});

describe('displayTitle', () => {
  it('leaves a title below the server cap alone', () => {
    expect(displayTitle('Plan the launch')).toBe('Plan the launch');
  });
  it('collapses embedded line breaks before measuring or displaying', () => {
    expect(displayTitle('Hello\nHello\nHello')).toBe('Hello Hello Hello');
  });
  it('ends a capped title at a word with an ellipsis, not mid-word', () => {
    expect(displayTitle('Search the workspace with tools and summar')).toBe('Search the workspace with tools and…');
  });
  it('still marks one long unbroken word as cut', () => {
    expect(displayTitle('x'.repeat(42))).toBe(`${'x'.repeat(42)}…`);
  });
});
