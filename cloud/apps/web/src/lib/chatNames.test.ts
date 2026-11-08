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

it('never reuses a name one of the chats already has: retries, then numbers it', async () => {
  const { uniqueChatName, NAME_ATTEMPTS } = await import('./chatNames');
  // The first pick collides (any case and spacing), the retry does not.
  const seq = [0, 0, 0.999, 0.999];
  let i = 0;
  expect(uniqueChatName([' quiet harbor '], () => seq[i++]!)).toBe('Cosmic Willow');
  // Every random pick collides: the last pick gets the first free number.
  expect(uniqueChatName(['Quiet Harbor', 'Quiet Harbor 2'], () => 0)).toBe('Quiet Harbor 3');
  let calls = 0;
  uniqueChatName(['Quiet Harbor'], () => { calls++; return 0; });
  expect(calls).toBe(NAME_ATTEMPTS * 2);
  // With all 256 pairs taken, still unique.
  const all = NAME_ADJECTIVES.flatMap(a => NAME_NOUNS.map(n => `${a} ${n}`));
  const name = uniqueChatName(all);
  expect(all).not.toContain(name);
  expect(name).toMatch(/ 2$/);
  // Random use over a growing list stays unique.
  const titles: string[] = [];
  for (let k = 0; k < 400; k++) titles.push(uniqueChatName(titles));
  expect(new Set(titles.map(t => t.toLowerCase())).size).toBe(400);
});
