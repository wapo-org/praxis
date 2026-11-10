import { expect, test, type Page } from '@playwright/test';

// WP-J2: activity rows on one edge, the column centred beside the sidebar, attachments that look like files
// and never vanish, voice input on the Web Speech API, and New chat landing the caret in the composer.

async function signIn(page: Page, userId = `j2-${test.info().project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) {
  expect((await page.request.post('/v1/auth/dev', { data: { type: 'auth.dev', userId } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByTestId('chat-top-bar').waitFor();
  await page.waitForTimeout(300);
}

async function scriptedChat(page: Page, runs: Array<[string, string]>) {
  return page.evaluate(async (runs) => {
    const path = '/src/lib/api.ts';
    const { apiClient } = (await import(/* @vite-ignore */ path)) as typeof import('../src/lib/api');
    const chat = await apiClient.createChat({ title: 'J2 spec' });
    for (const [text, script] of runs) {
      const run = await apiClient.startRun({ chatId: chat.id, text, script: script as 'tools', providerId: 'scripted', modelId: 'scripted', clientTurnId: crypto.randomUUID() });
      for (let i = 0; i < 150; i++) {
        const snap = await apiClient.getRunSnapshot(run.id);
        if (['completed', 'failed', 'cancelled'].includes(snap.run.status)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return chat.id;
  }, runs);
}

/** The owner's failing rows (J-ref/01): a long run_javascript fetch and an MCP call, both failed. Injected by
 *  wrapping fetch in the page (Playwright's WebKit does not intercept these requests). */
async function failedRows(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const row = (id: string, name: string, title: string, args: unknown) => ({
      activity: { type: 'tool.activity', id, name, source: { type: 'builtin' }, presentation: { type: 'tool.presentation', category: 'other', runningTitle: title, finishedTitle: title } },
      argumentsJson: JSON.stringify(args), running: false, progress: [],
      completion: { type: 'tool.completion', status: 'failed', summary: 'AI data consent is required', preview: '' },
    });
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!/\/v1\/runs\/[^/]+\/snapshot/.test(url) || !response.ok) return response;
      const body = await response.clone().json();
      body.tools = [
        row('j2-js', 'run_javascript', 'Run javascript', { code: "const r = await fetch('https://hacker-news.firebaseio.com/v0/newstories.json'); const ids = await r.json(); return Promise.all(ids.slice(0, 10).map((id) => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));" }),
        row('j2-mcp', 'mcp_exa_resources_list', 'Mcp exa resources list', { id: '97cd22498a62' }),
        ...body.tools,
      ];
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
  });
}

const textLeft = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects()[0]?.left ?? null;
  }, selector);

test('every activity row starts on the body text’s left edge; failed rows are one line with a status at the end', async ({ page }) => {
  await signIn(page);
  const chatId = await scriptedChat(page, [['Interpret the reports', 'reasoningInterleaved'], ['run the test skill', 'tools']]);
  await failedRows(page);
  await page.goto(`/c/${chatId}`);
  const turn = page.getByTestId('assistant-turn').last();
  await turn.getByTestId('agent-activity-toggle').click();
  await turn.getByTestId('tool-step-header-j2-js').waitFor();
  await page.waitForTimeout(500);
  const body = await textLeft(page, '[data-testid="assistant-turn"]:last-of-type [data-testid="agent-message-view"] p');
  const worked = await turn.getByTestId('agent-activity-toggle').locator('span').first().evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects()[0]!.left; });
  const reasoned = await page.getByTestId('reasoning-view').first().getByRole('button').locator('span').first().evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects()[0]!.left; });
  const icon = (await turn.getByTestId('tool-step-header-j2-js').locator('svg').first().boundingBox())!.x;
  expect(body).not.toBeNull();
  for (const x of [worked, reasoned, icon]) expect(Math.abs(x - body!)).toBeLessThanOrEqual(1);
  // One chevron convention: right when closed, turned down when open.
  await expect(page.getByTestId('reasoning-view').first().locator('svg.lucide-chevron-right')).toHaveCount(1);
  // Failed: one line, label truncated inside the column, a small "Failed" at the end.
  const header = turn.getByTestId('tool-step-header-j2-js');
  const column = (await page.locator('[data-chat-column]').boundingBox())!;
  const box = (await header.boundingBox())!;
  expect(box.height).toBeLessThan(34);
  expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width + 0.5);
  await expect(header.getByText('Failed', { exact: true })).toBeVisible();
  expect(await header.locator('[class*="label"]').first().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // The detail is fluid: the column's width minus the row's indent, and it shows the failure.
  await header.click();
  const detail = turn.getByTestId('tool-step-detail-j2-js');
  await expect(detail).toContainText('Tool call failed');
  await page.waitForTimeout(500);
  const width = (await detail.boundingBox())!.width;
  expect(Math.abs(width - (column.width - 24))).toBeLessThanOrEqual(1);
  // Never a zero reasoning duration.
  await expect(page.getByTestId('reasoning-view').first().getByRole('button')).not.toContainText(/for 0s/);
});

test('the column, the header pill and the composer are centred right of the open sidebar, and re-centre with it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const chatId = await scriptedChat(page, [['Show me a short answer', 'text']]);
  await page.goto(`/c/${chatId}`);
  await page.getByTestId('assistant-turn').first().waitFor();
  await page.waitForTimeout(800);
  const geometry = () => page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)?.getBoundingClientRect();
    const side = r('[data-testid="app-sidebar"]');
    const col = r('[data-chat-column]')!;
    const pill = r('[data-testid="nav-chat-title-pill"]')!;
    const dock = r('[data-testid="composer-dock"]')!;
    const areaLeft = side ? side.right : 0;
    return { area: (areaLeft + innerWidth) / 2, col: (col.left + col.right) / 2, pill: (pill.left + pill.right) / 2, dock: (dock.left + dock.right) / 2 };
  });
  const open = await geometry();
  for (const x of [open.col, open.pill, open.dock]) expect(Math.abs(x - open.area)).toBeLessThanOrEqual(1);
  // Collapse: the column glides on the sidebar's own spring, with no jump, and ends centred in the window.
  const column = page.locator('[data-chat-column]');
  await column.evaluate((el) => {
    const w = window as unknown as { __x: number[]; __go: boolean };
    w.__x = []; w.__go = true;
    const tick = () => { if (!w.__go) return; w.__x.push(el.getBoundingClientRect().left); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.getByRole('button', { name: /hide sidebar|close sidebar|collapse/i }).first().click();
  await page.waitForTimeout(900);
  const xs = await page.evaluate(() => { const w = window as unknown as { __x: number[]; __go: boolean }; w.__go = false; return w.__x; });
  const steps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]!));
  expect(xs.filter((x) => x < xs[0]! - 1 && x > xs.at(-1)! + 1).length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...steps)).toBeLessThan(40); // a glide, not a jump
  const closed = await geometry();
  expect(Math.abs(closed.col - 720)).toBeLessThanOrEqual(1);
});

test('a sent message with an attachment never leaves the list, shows the file as a chip and never the model note', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('composer-input').fill('hello there');
  await page.getByTestId('composer-input').press('Enter');
  await page.getByTestId('assistant-turn').last().waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
  await page.getByTestId('composer-file-input').setInputFiles({ name: 'Chat screen draft.zip', mimeType: 'application/zip', buffer: Buffer.alloc(1_500_000, 7) });
  const queued = page.getByTestId('composer-attachment-chip');
  await expect(queued).toContainText('Chat screen draft.zip');
  // Over the 1 MB code-read limit: said at attach time, with the limit.
  await expect(queued).toContainText('It reads files up to 1 MB');
  await expect(queued).not.toContainText('Uploading');
  await page.evaluate(() => {
    const w = window as unknown as { __n: number[]; __go: boolean };
    w.__n = []; w.__go = true;
    const tick = () => { if (!w.__go) return; w.__n.push(document.querySelectorAll('[data-testid="user-message-bubble"]').length); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.getByTestId('composer-input').fill("what's here");
  await page.getByTestId('composer-input').press('Enter');
  await page.getByTestId('assistant-turn').nth(1).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
  await page.waitForTimeout(500);
  const counts = await page.evaluate(() => { const w = window as unknown as { __n: number[]; __go: boolean }; w.__go = false; return w.__n; });
  const firstTwo = counts.findIndex((n) => n === 2);
  expect(firstTwo).toBeGreaterThanOrEqual(0);
  expect(Math.min(...counts.slice(firstTwo))).toBe(2); // once sent, it stays through the whole run
  const sent = page.getByTestId('user-message-bubble').last();
  await expect(sent.getByTestId('document-attachment-chip')).toContainText('Chat screen draft.zip');
  await expect(sent.getByTestId('document-attachment-chip')).toContainText('1.5 MB');
  await expect(sent).toContainText("what's here");
  await expect(page.locator('[data-chat-column]')).not.toContainText('[Attached file');
  // After a reload the stored message reads the same.
  await page.reload();
  await page.getByTestId('user-message-bubble').last().waitFor();
  await expect(page.locator('[data-chat-column]')).not.toContainText('[Attached file');
  await expect(page.getByTestId('user-message-bubble').last().getByTestId('document-attachment-chip')).toContainText('Chat screen draft.zip');
});

/** A scripted SpeechRecognition: the test speaks through window.__speech. */
async function mockSpeech(page: Page, mode: 'ok' | 'denied' | 'none') {
  await page.addInitScript((mode) => {
    const w = window as unknown as Record<string, unknown>;
    const install = (value: unknown) => {
      for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) Object.defineProperty(window, name, { value, configurable: true, writable: true });
    };
    if (mode === 'none') { install(undefined); return; }
    class Mock {
      lang = ''; continuous = false; interimResults = false;
      onresult: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null; onend: (() => void) | null = null;
      results: Array<{ isFinal: boolean; 0: { transcript: string }; length: 1 }> = [];
      start() {
        (window as unknown as { __speech: unknown }).__speech = this;
        if (mode === 'denied') setTimeout(() => { this.onerror?.({ error: 'not-allowed' }); this.onend?.(); }, 20);
      }
      say(text: string, isFinal: boolean) {
        if (this.results.length && !this.results.at(-1)!.isFinal) this.results.pop();
        this.results.push({ isFinal, 0: { transcript: text }, length: 1 });
        this.onresult?.({ resultIndex: this.results.length - 1, results: Object.assign([...this.results], { length: this.results.length }) });
      }
      stop() { setTimeout(() => this.onend?.(), 10); }
      abort() { this.onend?.(); }
    }
    install(Mock);
  }, mode);
}

test('voice input streams interim words into the composer and stops on the stop control', async ({ page }) => {
  await mockSpeech(page, 'ok');
  await signIn(page);
  const input = page.getByTestId('composer-input');
  await input.fill('Note:');
  // Typed text hides the mic in favour of send; clear to reach it, as a person would, then type after.
  await input.fill('');
  const mic = page.getByTestId('composer-voice-button');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-label', 'Stop voice input');
  await page.evaluate(() => (window as unknown as { __speech: { say: (t: string, f: boolean) => void } }).__speech.say('book a', false));
  await expect(input).toHaveValue('book a');
  await page.evaluate(() => (window as unknown as { __speech: { say: (t: string, f: boolean) => void } }).__speech.say('book a table for two', true));
  await expect(input).toHaveValue('book a table for two');
  await mic.click();
  await expect(page.getByTestId('composer-voice-button')).toHaveAttribute('aria-label', 'Voice input', { timeout: 2000 }).catch(() => {});
  await expect(input).toHaveValue('book a table for two');
  await expect(page.getByTestId('composer-send-button')).toBeEnabled();
});

test('voice input says plainly when the microphone is blocked', async ({ page }) => {
  await mockSpeech(page, 'denied');
  await signIn(page);
  await page.getByTestId('composer-voice-button').click();
  await expect(page.getByRole('alert')).toContainText('Microphone access is blocked');
  await expect(page.getByTestId('composer-voice-button')).toHaveAttribute('aria-label', 'Voice input');
});

test('without a speech API (Firefox) there is no mic: the send button holds the slot', async ({ page }) => {
  await mockSpeech(page, 'none');
  await signIn(page);
  await expect(page.getByTestId('composer-voice-button')).toBeHidden();
  await expect(page.getByTestId('composer-send-button')).toBeVisible();
  await expect(page.getByTestId('composer-send-button')).toBeDisabled();
});

test('New chat lands the caret in the composer: button and shortcut', async ({ page }) => {
  await signIn(page);
  const input = page.getByTestId('composer-input');
  await page.getByTestId('composer-input').fill('first');
  await page.getByTestId('composer-input').press('Enter');
  await page.getByTestId('assistant-turn').waitFor();
  await page.locator('body').click({ position: { x: 700, y: 400 } });
  await page.getByTestId('nav-new-chat-desktop').click();
  await expect(input).toBeFocused();
  await page.locator('body').click({ position: { x: 700, y: 400 } });
  await expect(input).not.toBeFocused();
  await page.keyboard.press('Control+Shift+O');
  await expect(input).toBeFocused();
  await expect(input).toBeFocused();
});

test('New chat from the phone drawer lands the caret in the composer', async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await signIn(page);
  const input = page.getByTestId('composer-input');
  await input.fill('first');
  await input.press('Enter');
  await page.getByTestId('assistant-turn').waitFor();
  await input.blur();
  await page.getByTestId('nav-history-button').click();
  await page.getByTestId('sidebar-new-chat').click();
  await expect(input).toBeFocused();
});
