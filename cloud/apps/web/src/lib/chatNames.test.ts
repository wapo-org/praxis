import { expect, it } from 'vitest';
import { NAME_ADJECTIVES, NAME_NOUNS, randomChatName } from './chatNames';

it('names a chat with one word from each of the source lists', () => {
  expect(NAME_ADJECTIVES).toHaveLength(16);
  expect(NAME_NOUNS).toHaveLength(16);
  expect(randomChatName(() => 0)).toBe('Quiet Harbor');
  expect(randomChatName(() => 0.999)).toBe('Cosmic Willow');
  for (let i = 0; i < 50; i++) {
    const [a, n] = randomChatName().split(' ');
    expect(NAME_ADJECTIVES).toContain(a);
    expect(NAME_NOUNS).toContain(n);
  }
});
