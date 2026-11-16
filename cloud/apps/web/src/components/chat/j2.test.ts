import { describe, expect, it } from 'vitest';
import { attachmentKind, attachmentLimit, formatBytes } from './attachmentInfo';
import { reasoningLabel, reasoningSegments } from './ReasoningView';
import { joinSpoken, speechErrorMessage } from './useSpeechInput';
import { isClampedToCapsule } from '../../../../../packages/glass/src/squircle';

describe('reasoning labels (WP-J2)', () => {
  it('never shows a zero duration', () => {
    expect(reasoningLabel(false, 0)).toBe('Reasoned briefly');
    expect(reasoningLabel(false, 420)).toBe('Reasoned briefly');
    expect(reasoningLabel(false, 1200)).toBe('Reasoned for 1.2s');
    expect(reasoningLabel(false, null)).toBe('Reasoned');
    expect(reasoningLabel(true, 0)).toBe('Reasoning…');
  });
  it('drops the blank line pre-wrap would add under a reasoning title', () => {
    expect(reasoningSegments('**Interpreting financial reports**\n\nI’m looking at the figures.\n\n**Next**\nMore.')).toEqual([
      { title: true, text: 'Interpreting financial reports' },
      { title: false, text: 'I’m looking at the figures.' },
      { title: true, text: 'Next' },
      { title: false, text: 'More.' },
    ]);
  });
});

describe('attachments (WP-J2)', () => {
  it('names the kind and size in plain words', () => {
    expect(attachmentKind('Chat screen draft.zip', 'application/zip')).toBe('archive');
    expect(attachmentKind('photo.png', 'image/png')).toBe('image');
    expect(attachmentKind('numbers.csv', 'text/csv')).toBe('sheet');
    expect(formatBytes(3_000_626)).toBe('3 MB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(18_837)).toBe('19 KB');
  });
  it('states limits at attach time, mirroring how the API hands each file to the model', () => {
    expect(attachmentLimit({ name: 'big.mov', mediaType: 'video/quicktime', size: 30_000_000 })).toEqual({ level: 'block', message: 'Too large to attach. The limit is 25 MB.' });
    expect(attachmentLimit({ name: 'Chat screen draft.zip', mediaType: 'application/zip', size: 3_000_000 })?.message).toBe('Too large for Praxis to open. It reads files up to 1 MB.');
    expect(attachmentLimit({ name: 'small.zip', mediaType: 'application/zip', size: 400_000 })).toBeNull();
    expect(attachmentLimit({ name: 'paper.pdf', mediaType: 'application/pdf', size: 8_000_000 })).toBeNull();
    expect(attachmentLimit({ name: 'photo.jpg', mediaType: 'image/jpeg', size: 20_000_000 })).toBeNull();
  });
});

describe('voice input (WP-J2)', () => {
  it('joins what was typed with what was heard', () => {
    expect(joinSpoken('', '  book a   table ')).toBe('book a table');
    expect(joinSpoken('Note:', 'book a table')).toBe('Note: book a table');
    expect(joinSpoken('Note: ', 'book')).toBe('Note: book');
    expect(joinSpoken('Note:', '')).toBe('Note:');
  });
  it('explains every error in plain words, and stays silent on its own stop', () => {
    expect(speechErrorMessage('not-allowed')).toMatch(/Microphone access is blocked/);
    expect(speechErrorMessage('no-speech')).toMatch(/Didn’t catch that/);
    expect(speechErrorMessage('aborted')).toBe('');
  });
});

describe('glass corners (WP-J2)', () => {
  it('treats a corner clamped to half the short side as a capsule (the 52 px composer with a 44 px token)', () => {
    expect(isClampedToCapsule(44, 720, 52)).toBe(true);
    expect(isClampedToCapsule(44, 720, 120)).toBe(false);
    expect(isClampedToCapsule(42, 300, 84)).toBe(true);
  });
});
