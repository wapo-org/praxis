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

/** Random tries before falling back to a numbered name. */
export const NAME_ATTEMPTS = 24;

/**
 * A random name none of `taken` (the user's chat titles) already uses, ignoring case and outer spaces. After
 * NAME_ATTEMPTS collisions (a user with most of the 256 pairs) it numbers the last pick: "Quiet Harbor 2".
 */
export function uniqueChatName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set<string>();
  for (const title of taken) used.add(title.trim().toLocaleLowerCase());
  let name = randomChatName(random);
  for (let i = 1; i < NAME_ATTEMPTS && used.has(name.toLocaleLowerCase()); i++) name = randomChatName(random);
  if (!used.has(name.toLocaleLowerCase())) return name;
  for (let n = 2; ; n++) if (!used.has(`${name} ${n}`.toLocaleLowerCase())) return `${name} ${n}`;
}
