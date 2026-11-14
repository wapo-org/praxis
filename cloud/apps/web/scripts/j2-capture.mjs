// WP-J2 captures: activity rows, centring, attachments, progressive blur. Before and after use the same scenes.
//   BASE=http://127.0.0.1:5232 TAG=before|after [ONLY=activity,centre,attach,blur] node apps/web/scripts/j2-capture.mjs
import { chromium, webkit } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const TAG = process.env.TAG ?? 'before';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/J/J2`;
const FX = process.env.FX ?? '/tmp/j2/fx';
const ONLY = new Set((process.env.ONLY ?? 'activity,centre,attach,blur').split(','));
await mkdir(OUT, { recursive: true });

async function open(browserType, { width = 1440, height = 900, dpr = 2, scheme = 'dark', path = '/' } = {}) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: scheme });
  await context.addInitScript((mode) => localStorage.setItem('praxis-theme', mode), scheme);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(BASE + path);
  const dev = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
  // An account-synced theme wins over the local one; captures compare like with like.
  await page.evaluate(async (mode) => { const { apiClient } = await import('/src/lib/api.ts'); await apiClient.request('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field: 'theme', value: mode }) }).catch(() => {}); localStorage.setItem('praxis-theme', mode); }, scheme).catch(() => {});
  await page.reload(); await page.getByTestId('chat-top-bar').waitFor();
  await page.waitForTimeout(600);
  return { browser, context, page };
}

/** A chat with real scripted runs, made through the app's own client. */
async function scriptedChat(page, title, runs) {
  return page.evaluate(async ({ title, runs }) => {
    const { apiClient } = await import('/src/lib/api.ts');
    const chat = await apiClient.createChat({ title });
    for (const [text, script] of runs) {
      const run = await apiClient.startRun({ chatId: chat.id, text, script, providerId: 'scripted', modelId: 'scripted', clientTurnId: crypto.randomUUID(), ...(script.startsWith('reasoning') ? { streamSim: { speed: '1500tps' } } : {}) });
      for (let i = 0; i < 300; i++) {
        const snap = await apiClient.getRunSnapshot(run.id);
        if (['completed', 'failed', 'cancelled'].includes(snap.run.status)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return chat.id;
  }, { title, runs });
}

/** Adds the owner's failing rows (J-ref/01) and a skill load (J-ref/10, 11) to every recovered run. */
async function injectTools(page) {
  await page.route('**/v1/runs/*/snapshot', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const act = (id, name, title, args, status, summary, preview) => ({
      activity: { type: 'tool.activity', id, name, source: { type: 'builtin' }, presentation: { type: 'tool.presentation', category: 'other', runningTitle: title, finishedTitle: title } },
      argumentsJson: JSON.stringify(args), running: false, progress: [],
      completion: { type: 'tool.completion', status, summary, preview },
    });
    body.tools = [
      act('j2-skill', 'load_skill', 'Load skill', { name: 'test-skill' }, 'succeeded', 'Loaded test-skill', '# Test Skill\n\nWhen the user asks to run this skill:\n1. Respond: "Test skill loaded successfully."\n2. Explain briefly that this confirms the skill can be saved and loaded.\n\nDo not call external tools or change any data when running this skill.'),
      act('j2-js', 'run_javascript', 'Run javascript', { code: "const r = await fetch('https://hacker-news.firebaseio.com/v0/newstories.json'); const ids = await r.json(); const items = await Promise.all(ids.slice(0,10).map(id => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()))); return items;" }, 'failed', 'AI data consent is required for hacker-news.firebaseio.com', ''),
      act('j2-mcp', 'mcp_exa_resources_list', 'Mcp exa resources list', { id: '97cd22498a62' }, 'failed', 'Request failed', ''),
      ...body.tools,
    ];
    await route.fulfill({ response, json: body });
  });
}

async function crop(page, locator, name, pad = 16) {
  const box = await locator.boundingBox();
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
}

/** Slowed to 1/20 speed through the animation domain, so a screenshot every ~100 ms is one real frame. */
async function frames(page, locator, act, name, count = 14) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
  const box = await locator.boundingBox();
  const clip = { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: Math.min(560, box.height + 360) };
  await act();
  for (let i = 0; i < count; i++) await page.screenshot({ path: `${OUT}/${name}-f${String(i).padStart(2, '0')}.png`, clip });
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  await page.waitForTimeout(600);
}

if (ONLY.has('activity')) {
  const { browser, page } = await open(chromium);
  const chatId = await scriptedChat(page, 'J2 activity', [['Interpret the financial reports', 'reasoningInterleaved'], ['run the test skill', 'tools']]);
  await injectTools(page);
  await page.goto(`${BASE}/c/${chatId}`);
  const toggle = page.getByTestId('agent-activity-toggle').last();
  await toggle.waitFor({ timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: '/tmp/j2/fail.png' }); throw e; });
  await page.waitForTimeout(1200);
  const turn = page.getByTestId('assistant-turn').last();
  await turn.scrollIntoViewIfNeeded();
  await crop(page, page.getByTestId('chat-scroll-viewport').locator('[data-chat-column]'), `${TAG}-1-rows-folded`, 0);
  if (TAG === 'after') await frames(page, turn, () => toggle.click(), `${TAG}-1-worked-open`);
  else await toggle.click();
  await page.waitForTimeout(700);
  await crop(page, turn, `${TAG}-1-worked-open`);
  const skill = page.getByTestId('tool-step-header-j2-skill').last();
  if (TAG === 'after') await frames(page, turn, () => skill.click(), `${TAG}-1-tool-open`);
  else await skill.click();
  await page.waitForTimeout(700);
  await crop(page, turn, `${TAG}-1-tool-open`);
  if (TAG === 'after') {
    await frames(page, turn, () => skill.click(), `${TAG}-1-tool-close`);
    await frames(page, turn, () => toggle.click(), `${TAG}-1-worked-close`);
  }
  const first = page.getByTestId('agent-activity-view').first();
  await first.scrollIntoViewIfNeeded();
  await crop(page, page.getByTestId('assistant-turn').first(), `${TAG}-1-reasoning`);
  // Left edges: body text, header label, first tool icon.
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  if ((await skill.getAttribute('aria-expanded')) !== 'true') await skill.click();
  await page.waitForTimeout(700);
  const edges = await page.evaluate(() => {
    const turn = [...document.querySelectorAll('[data-testid="assistant-turn"]')].at(-1);
    const left = (el) => (el ? Math.round(el.getBoundingClientRect().left * 10) / 10 : null);
    const textLeft = (el) => { if (!el) return null; const r = document.createRange(); r.selectNodeContents(el); return Math.round(r.getClientRects()[0]?.left * 10) / 10; };
    return {
      body: textLeft(turn.querySelector('[data-testid="agent-message-view"] p')),
      worked: textLeft(turn.querySelector('[data-testid="agent-activity-toggle"] span')),
      reasoned: textLeft(document.querySelector('[data-testid="reasoning-view"] button span')),
      toolIcon: left(turn.querySelector('[data-testid^="tool-step-header-"] svg')),
      toolLabel: textLeft(turn.querySelector('[data-testid^="tool-step-header-"] [class*="label"]')),
      detailWidth: turn.querySelector('[data-testid^="tool-step-detail-"]')?.getBoundingClientRect().width ?? null,
      columnWidth: document.querySelector('[data-chat-column]').getBoundingClientRect().width,
    };
  });
  await writeFile(`${OUT}/${TAG}-1-edges.json`, JSON.stringify(edges, null, 2));
  console.log('edges', edges);
  await browser.close();
}

if (ONLY.has('centre')) {
  const report = {};
  for (const width of [900, 1024, 1280, 1440, 1920, 2560]) {
    const { browser, page } = await open(chromium, { width, height: 900, dpr: 1 });
    const chatId = await scriptedChat(page, 'J2 centring', [['Show me a short answer', 'text']]);
    await page.goto(`${BASE}/c/${chatId}`);
    await page.getByTestId('assistant-turn').first().waitFor();
    if (width >= 1024 && !(await page.getByTestId('app-sidebar').isVisible().catch(() => false))) await page.getByRole('button', { name: /sidebar/i }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    const geo = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const side = r('[data-testid="app-sidebar"]');
      const col = r('[data-chat-column]');
      const pill = r('[data-testid="nav-chat-title-pill"]');
      const dock = r('[data-testid="composer-dock"]');
      const right = window.innerWidth;
      const areaLeft = side ? side.right : 0;
      return { width: right, sidebarRight: side?.right ?? null, columnLeftGap: col.left - areaLeft, columnRightGap: right - col.right, columnCentre: (col.left + col.right) / 2, areaCentre: (areaLeft + right) / 2, pillCentre: pill ? (pill.left + pill.right) / 2 : null, dockCentre: (dock.left + dock.right) / 2 };
    });
    report[width] = geo;
    if ([1280, 1440, 1920, 2560].includes(width)) await page.screenshot({ path: `${OUT}/${TAG}-2-centre-${width}.png` });
    await browser.close();
  }
  await writeFile(`${OUT}/${TAG}-2-centre.json`, JSON.stringify(report, null, 2));
  console.log('centre', report);
}

if (ONLY.has('attach')) {
  const { browser, page } = await open(chromium);
  await page.getByTestId('sidebar-new-chat').click().catch(() => {});
  await page.getByTestId('composer-file-input').setInputFiles([`${FX}/Chat screen draft.zip`, `${FX}/bright.png`]);
  await page.waitForTimeout(1200);
  await crop(page, page.getByTestId('composer-dock'), `${TAG}-3-attach-queued`);
  await page.getByTestId('composer-input').fill("what's here");
  await page.getByTestId('composer-input').press('Enter');
  const shots = [[60, 'sent'], [700, 'midrun'], [6000, 'done']];
  let last = 0;
  for (const [at, label] of shots) {
    await page.waitForTimeout(at - last); last = at;
    await page.screenshot({ path: `${OUT}/${TAG}-3-attach-${label}.png` });
    const visible = await page.evaluate(() => [...document.querySelectorAll('[data-testid="user-message-bubble"]')].map((el) => ({ text: el.innerText.slice(0, 80), hidden: getComputedStyle(el.querySelector('[data-user-bubble]') ?? el).visibility })));
    console.log(label, JSON.stringify(visible));
  }
  await browser.close();
}

if (ONLY.has('blur')) {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]].filter(([e]) => !process.env.ENGINE || e === process.env.ENGINE)) for (const scheme of ['dark', 'light'].filter((s) => !process.env.SCHEME || s === process.env.SCHEME)) {
    const { browser, page } = await open(type, { width: 1280, height: 800, scheme });
    await page.getByTestId('composer-file-input').setInputFiles([`${FX}/bright.png`]);
    await page.waitForTimeout(1200);
    await page.getByTestId('composer-input').fill('Describe this picture');
    await page.getByTestId('composer-input').press('Enter');
    await page.waitForURL('**/c/*');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 30000 });
    const chatId = new URL(page.url()).pathname.split('/').pop();
    await page.evaluate(async (chatId) => {
      const { apiClient } = await import('/src/lib/api.ts');
      for (const text of ['Now write a long answer', 'And another long one']) {
        let run;
        for (let i = 0; i < 100 && !run; i++) run = await apiClient.startRun({ chatId, text, script: 'long', providerId: 'scripted', modelId: 'scripted', clientTurnId: crypto.randomUUID() }).catch(() => new Promise((r) => setTimeout(r, 300)));
        for (let i = 0; i < 300; i++) { const s = await apiClient.getRunSnapshot(run.id); if (['completed', 'failed', 'cancelled'].includes(s.run.status)) break; await new Promise((r) => setTimeout(r, 200)); }
      }
    }, chatId);
    await page.reload();
    await page.locator('[data-testid="user-message-bubble"] img').first().waitFor();
    await page.waitForTimeout(1500);
    for (const edge of ['top', 'bottom']) {
      await page.evaluate((edge) => {
        const v = document.querySelector('[data-testid="chat-scroll-viewport"]');
        const im = document.querySelector('[data-testid="user-message-bubble"] img');
        const r = im.getBoundingClientRect();
        v.scrollTop += edge === 'top' ? r.top + 40 : r.bottom - (window.innerHeight - 40);
      }, edge);
      await page.waitForTimeout(500);
      const h = edge === 'top' ? 130 : 170;
      await page.screenshot({ path: `${OUT}/${TAG}-5-blur-${edge}-${engine}-${scheme}.png`, clip: { x: 280, y: edge === 'top' ? 0 : 800 - h, width: 1000, height: h } });
    }
    await browser.close();
  }
}
