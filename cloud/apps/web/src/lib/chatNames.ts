/**
 * Design v2 names a new chat at random from two word lists (Chat Screen.dc.html, `randomName()`), and sending a
 * message keeps that name: the first message no longer titles the chat. The user can still rename it.
 */
export const NAME_ADJECTIVES = ['Quiet', 'Amber', 'Silver', 'Lazy', 'Brave', 'Hidden', 'Crimson', 'Gentle', 'Rapid', 'Misty', 'Golden', 'Curious', 'Velvet', 'Lunar', 'Wild', 'Cosmic'] as const;
export const NAME_NOUNS = ['Harbor', 'Fox', 'Lantern', 'Orchard', 'Compass', 'Meadow', 'Comet', 'Anchor', 'Thicket', 'Ember', 'Canyon', 'Pebble', 'Sparrow', 'Atlas', 'Kettle', 'Willow'] as const;

export function randomChatName(random: () => number = Math.random): string {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  return `${pick(NAME_ADJECTIVES)} ${pick(NAME_NOUNS)}`;
}
