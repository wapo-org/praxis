export const NAME_ADJECTIVES = ['Quiet', 'Amber', 'Silver', 'Lazy', 'Brave', 'Hidden', 'Crimson', 'Gentle', 'Rapid', 'Misty', 'Golden', 'Curious', 'Velvet', 'Lunar', 'Wild', 'Cosmic'] as const;
export const NAME_NOUNS = ['Harbor', 'Fox', 'Lantern', 'Orchard', 'Compass', 'Meadow', 'Comet', 'Anchor', 'Thicket', 'Ember', 'Canyon', 'Pebble', 'Sparrow', 'Atlas', 'Kettle', 'Willow'] as const;

export function randomChatName(random: () => number = Math.random): string {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  return `${pick(NAME_ADJECTIVES)} ${pick(NAME_NOUNS)}`;
}

/** Random tries before falling back to a numbered name. */
export const NAME_ATTEMPTS = 24;

const key = (title: string | null | undefined) => (title ?? '').trim().toLocaleLowerCase();

/** Whether one of `titles` already is `name` (ignoring case and outer spaces). */
export function nameTaken(titles: Iterable<string | null | undefined>, name: string): boolean {
  const wanted = key(name);
  for (const title of titles) if (key(title) === wanted) return true;
  return false;
}

export function uniqueChatName(taken: Iterable<string | null | undefined>, random: () => number = Math.random): string {
  const used = new Set<string>();
  for (const title of taken) used.add(key(title));
  let name = randomChatName(random);
  for (let i = 1; i < NAME_ATTEMPTS && used.has(name.toLocaleLowerCase()); i++) name = randomChatName(random);
  if (!used.has(name.toLocaleLowerCase())) return name;
  for (let n = 2; ; n++) if (!used.has(`${name} ${n}`.toLocaleLowerCase())) return `${name} ${n}`;
}
