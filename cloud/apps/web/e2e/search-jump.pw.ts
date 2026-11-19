import { apiRequest, openSignedInPage, signedInTest as test } from './sign-in';
import { expect } from '@playwright/test';

test('search jump centers deep matches smoothly after entrance, expands collapsed work groups, skips scroll on title-only, and snaps on mount', async ({
  page,
}) => {
  await openSignedInPage(page);
  await page.goto('/');
  await page.getByTestId('composer-input').waitFor();

  // 1. Seed a long chat (24 messages) where the match is near the top, far above default bottom scroll.
  const longChat = await (
    await apiRequest(page, 'post', '/v1/chats', { data: { type: 'chat.input', title: 'Long Archive' } })
  ).json();
  const filler = Array.from({ length: 24 }, (_, i) => ({
    type: 'message',
    id: `m-${i}`,
    chatId: longChat.id,
    role: i % 2 === 0 ? 'user' : 'assistant',
    sequence: i + 1,
    createdAt: new Date(Date.UTC(2026, 10, 13, 12, 0, i)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 10, 13, 12, 0, i)).toISOString(),
    parts: [
      {
        type: 'text',
        text:
          i === 2
            ? 'Critical finding: needle-early-chat-omega calibrates the gyroscope drift.'
            : `Long conversation filler turn #${i + 1} with enough lines of text to create realistic vertical scroll depth inside the chat viewport.`,
      },
    ],
  }));

  // 2. Seed an activity chat where the match is inside a collapsed work group (reasoning + text).
  const activityChat = await (
    await apiRequest(page, 'post', '/v1/chats', { data: { type: 'chat.input', title: 'Tool Worklog' } })
  ).json();
  const activityMessages = [
    {
      type: 'message',
      id: 'act-u1',
      chatId: activityChat.id,
      role: 'user',
      sequence: 1,
      createdAt: '2026-11-13T12:00:00.000Z',
      updatedAt: '2026-11-13T12:00:00.000Z',
      parts: [{ type: 'text', text: 'Inspect system logs please' }],
    },
    {
      type: 'message',
      id: 'act-a1',
      chatId: activityChat.id,
      role: 'assistant',
      sequence: 2,
      createdAt: '2026-11-13T12:00:02.000Z',
      updatedAt: '2026-11-13T12:00:04.000Z',
      parts: [
        { type: 'reasoning', text: 'Checking deep-collapsed-activity-token inside internal diagnostics.' },
        { type: 'text', text: 'Diagnostics completed cleanly.' },
      ],
    },
  ];

  // 3. Seed a title-only long chat (18 messages, none containing the title's search words).
  const titleOnlyChat = await (
    await apiRequest(page, 'post', '/v1/chats', { data: { type: 'chat.input', title: 'Zeppelin Title Only Hit' } })
  ).json();
  const titleOnlyMessages = Array.from({ length: 18 }, (_, i) => ({
    type: 'message',
    id: `to-${i}`,
    chatId: titleOnlyChat.id,
    role: i % 2 === 0 ? 'user' : 'assistant',
    sequence: i + 1,
    createdAt: new Date(Date.UTC(2026, 10, 13, 13, 0, i)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 10, 13, 13, 0, i)).toISOString(),
    parts: [{ type: 'text', text: `Routine status line #${i + 1} with zero matching title terms.` }],
  }));

  await page.route('**/v1/search?**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    if (q.includes('omega')) {
      return route.fulfill({
        json: {
          type: 'page',
          nextCursor: null,
          items: [{ chat: longChat, snippet: 'Critical finding: needle-early-chat-omega calibrates the gyroscope drift.' }],
        },
      });
    }
    if (q.includes('deep-collapsed')) {
      return route.fulfill({
        json: {
          type: 'page',
          nextCursor: null,
          items: [{ chat: activityChat, snippet: 'Checking deep-collapsed-activity-token inside internal diagnostics.' }],
        },
      });
    }
    if (q.includes('Zeppelin')) {
      return route.fulfill({
        json: {
          type: 'page',
          nextCursor: null,
          items: [{ chat: titleOnlyChat, snippet: 'Routine status line #1 with zero matching title terms.' }],
        },
      });
    }
    return route.continue();
  });

  await page.route(`**/v1/chats/${longChat.id}/messages**`, (route) =>
    route.fulfill({ json: { type: 'page', items: filler, nextCursor: null } }),
  );
  await page.route(`**/v1/chats/${activityChat.id}/messages**`, (route) =>
    route.fulfill({ json: { type: 'page', items: activityMessages, nextCursor: null } }),
  );
  await page.route(`**/v1/chats/${titleOnlyChat.id}/messages**`, (route) =>
    route.fulfill({ json: { type: 'page', items: titleOnlyMessages, nextCursor: null } }),
  );

  // Part A: Switch from existing ChatScreen -> long chat deep match: smooth scroll, centered, subtle highlight fades in ~1.75s
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByTestId('search-palette').getByRole('combobox');
  await input.fill('omega');
  await page.getByRole('option', { name: /Long Archive/ }).click();

  await expect(page).toHaveURL(new RegExp(`/c/${longChat.id}$`));
  const highlight = page.getByTestId('search-jump-highlight');
  await expect(highlight).toBeVisible({ timeout: 5000 });
  await expect(highlight).toHaveAttribute('data-highlight-kind', 'text');
  await expect(highlight).toHaveAttribute('data-scroll-behavior', 'smooth');

  // Verify the matched message was centered away from the bottom of the long chat
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const vp = document.querySelector<HTMLElement>('[data-testid="chat-scroll-viewport"]');
        const hl = document.querySelector<HTMLElement>('[data-testid="search-jump-highlight"] span');
        if (!vp || !hl) return -1;
        const vr = vp.getBoundingClientRect();
        const hr = hl.getBoundingClientRect();
        const padTop = parseFloat(getComputedStyle(vp).paddingTop) || 0;
        const padBottom = parseFloat(getComputedStyle(vp).paddingBottom) || 0;
        const center = vr.top + padTop + (vp.clientHeight - padTop - padBottom) / 2;
        return Math.abs(hr.top + hr.height / 2 - center);
      }),
    )
    .toBeLessThan(60);

  // Subtle highlight fades out cleanly after ~1.5-2 s
  await expect(highlight).toHaveCount(0, { timeout: 3500 });

  // Part B: Title-only match -> opens chat without jumping off the bottom or painting a highlight
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-palette').getByRole('combobox').fill('Zeppelin');
  await page.getByRole('option', { name: /Zeppelin Title Only Hit/ }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${titleOnlyChat.id}$`));
  await page.waitForTimeout(500);
  await expect(page.getByTestId('search-jump-highlight')).toHaveCount(0);
  const atBottom = await page.getByTestId('chat-scroll-viewport').evaluate((el) => {
    const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
    return dist <= 16;
  });
  expect(atBottom).toBe(true);

  // Part C: Match inside collapsed assistant work group -> expands fold & highlights matched text
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-palette').getByRole('combobox').fill('deep-collapsed');
  await page.getByRole('option', { name: /Tool Worklog/ }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${activityChat.id}$`));
  await expect(page.getByTestId('agent-activity-toggle').first()).toHaveAttribute('aria-expanded', 'true', {
    timeout: 5000,
  });
  await expect(page.getByTestId('search-jump-highlight')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('search-jump-highlight')).toHaveCount(0, { timeout: 3500 });

  // Part D: Opening search from Settings (ChatScreen just mounted) -> uses instant scroll
  await page.goto('/settings/general');
  await page.getByTestId('settings-back').waitFor();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-palette').getByRole('combobox').fill('omega');
  await page.getByRole('option', { name: /Long Archive/ }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${longChat.id}$`));
  await expect(page.getByTestId('search-jump-highlight')).toHaveAttribute('data-scroll-behavior', 'instant');
});
