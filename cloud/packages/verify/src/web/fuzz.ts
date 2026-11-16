import {expect, type Page} from '@playwright/test';
import type {WebFlow} from './flow-types.js';
import {SIGNED_OUT_SESSION_PROBE} from './judge.js';

/** Long enough to mix every action several times; each step is one user gesture. */
const FUZZ_STEPS_MAX = 24;
const ACTIONS = ['send', 'stop', 'reload', 'new-chat', 'switch-chat'] as const;
type FuzzAction = (typeof ACTIONS)[number];

/** mulberry32: tiny, seedable, good enough to pick actions reproducibly. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function actionPlan(seed: number, steps = FUZZ_STEPS_MAX): FuzzAction[] {
  const random = seededRandom(seed);
  return Array.from({length: steps}, () => ACTIONS[Math.floor(random() * ACTIONS.length)]!);
}

async function perform(page: Page, action: FuzzAction, index: number): Promise<void> {
  const composer = page.getByRole('textbox', {name: 'Message Praxis'});
  switch (action) {
    case 'send':
      await composer.fill(`fuzz ${index}`);
      await page.getByTestId('composer-send-button').click();
      return;
    case 'stop': {
      const stop = page.getByTestId('composer-stop-button');
      if (await stop.count()) await stop.click();
      return;
    }
    case 'reload':
      await page.reload();
      await page.getByTestId('chat-top-bar').waitFor();
      return;
    case 'new-chat':
      await page.getByRole('main').getByRole('button', {name: 'New chat'}).click();
      return;
    case 'switch-chat': {
      const chats = page.getByRole('complementary', {name: 'Conversation history'}).getByRole('region').getByRole('button');
      const count = await chats.count();
      if (count) await chats.nth(index % count).click();
      return;
    }
  }
}

/** Invariants after every gesture: the composer stays usable and the harness sees no unexpected browser error. */
export const fuzzChatFlow: WebFlow = {
  id: 'fuzz-chat',
  title: 'Seeded random send / stop / reload / new / switch with a usable composer after each step',
  default: false,
  allow: [SIGNED_OUT_SESSION_PROBE],
  async run({page, base, seed, note}) {
    await page.goto(base);
    await page.getByRole('button', {name: 'Continue as local dev user'}).click();
    await page.getByTestId('chat-top-bar').waitFor();
    const plan = actionPlan(seed);
    note(`seed ${seed}: ${plan.join(' ')}`);
    for (const [index, action] of plan.entries()) {
      try {
        await perform(page, action, index);
      } catch (error) {
        throw new Error(`step ${index} (${action}) failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, {cause: error});
      }
      await expect(page.getByRole('textbox', {name: 'Message Praxis'}), `composer unusable after step ${index} (${action})`).toBeEditable();
    }
  },
};
