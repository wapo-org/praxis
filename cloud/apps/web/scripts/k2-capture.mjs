// WP-K2 captures, before and after on the same scenes (items 1–7).
//   BASE=http://127.0.0.1:5232 TAG=before|after [ONLY=activity,type,tray,blur,press] node apps/web/scripts/k2-capture.mjs
import { chromium, webkit } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const TAG = process.env.TAG ?? 'before';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/K/K2`;
const FX = process.env.FX ?? '/tmp/j2/fx';
const ONLY = new Set((process.env.ONLY ?? 'activity,type,tray,blur,press').split(','));
const SCHEMES = (process.env.SCHEME ?? 'light,dark').split(',');
await mkdir(OUT, { recursive: true });

export async function open(browserType, { width = 1440, height = 900, dpr = 2, scheme = 'light', path = '/' } = {}) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: scheme, serviceWorkers: 'block' });
  await context.addInitScript((mode) => localStorage.setItem('praxis-theme', mode), scheme);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(BASE + path);
  const dev = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
  await page.evaluate(async (mode) => { const { apiClient } = await import('/src/lib/api.ts'); await apiClient.request('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field: 'theme', value: mode }) }).catch(() => {}); localStorage.setItem('praxis-theme', mode); }, scheme).catch(() => {});
  await page.reload(); await page.getByTestId('chat-top-bar').waitFor();
  await page.waitForTimeout(600);
  return { browser, context, page };
}

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

const FIRECRAWL_OUTPUT = JSON.stringify({ conversationId: 'ffbfedf1-60b5-4f50-bf0f-44cafd368b2c', success: true, data: { web: [
  { url: 'https://www.firecrawl.dev/pricing', title: 'Pricing', description: 'Firecrawl pricing', markdown: '# Pricing\n\n[Are you an AI agent? See pricing](https://www.firecrawl.dev/pricing.md)\n\n100,000\ncredits/month\n\nStandard $83/month\n\nPrices shown are per month, billed annually.' , position: 1 },
  { url: 'https://www.firecrawl.dev/', title: 'Firecrawl', description: 'Turn websites into LLM-ready data', position: 2 },
  { url: 'https://scrapegraphai.com/blog/firecrawl-pricing', title: 'Firecrawl pricing explained', position: 3 },
], ids: Array.from({ length: 24 }, (_, i) => i + 1) }, creditsUsed: 2 });

/** The owner's rows (K-ref/04, 05): MCP meta-tools with hashed names, a direct MCP call, a failure. */
async function injectTools(page) {
  await page.route('**/v1/runs/*/snapshot', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const act = (id, name, args, status, preview, source = { type: 'builtin' }, display) => ({
      activity: { type: 'tool.activity', id, name, source, presentation: { type: 'tool.presentation', category: 'other', runningTitle: name, finishedTitle: name }, ...(display ? { display } : {}) },
      argumentsJson: JSON.stringify(args), running: false, progress: [],
      completion: { type: 'tool.completion', status, summary: status === 'failed' ? 'Request failed' : 'Tool completed', preview },
    });
    const fc = { type: 'mcp', serverId: 'firecrawl', serverName: 'Firecrawl' };
    body.tools = [
      act('k2-describe', 'mcp_describe_tool', { tool: 'mcp__firecrawl__firecrawl_search_bbc9571288db' }, 'succeeded', JSON.stringify({ name: 'firecrawl_search', description: 'Search the web and optionally scrape results.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } })),
      act('k2-call', 'mcp_call_tool', { tool: 'mcp__firecrawl__firecrawl_search_bbc9571288db', arguments: { limit: 3, objective: 'Test Firecrawl search functionality', query: 'Firecrawl pricing' } }, 'succeeded', FIRECRAWL_OUTPUT),
      act('k2-search', 'mcp__firecrawl__firecrawl_search_bbc9571288db', { query: 'Firecrawl pricing', limit: 3 }, 'succeeded', FIRECRAWL_OUTPUT, fc),
      act('k2-crawl', 'mcp__firecrawl__firecrawl_crawl_ece4ef24cbd6', { url: 'https://example.com', limit: 2, maxDepth: 1 }, 'failed', 'Crawl job timed out after 30s', fc),
      act('k2-exa', 'mcp__exa__web_search_exa_97cd22498a62', { query: 'praxis cloud liquid glass' }, 'succeeded', '{"results":[]}', { type: 'mcp', serverId: 'exa', serverName: 'Exa' }, { title: 'Exa search', detail: 'praxis cloud liquid glass', connectorId: 'exa', connectorName: 'Exa', icon: 'search' }),
      ...body.tools,
    ];
    await route.fulfill({ response, json: body });
  });
}

async function crop(page, locator, name, pad = 16) {
  const box = await locator.boundingBox();
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: Math.min(box.height + pad * 2, 1600) } });
}

export const TYPOGRAPHY = `Checking Firecrawl search + crawl now — testing both live. Both work, and the first paragraph runs long enough to show the measure: about sixty-six to seventy characters before it wraps onto the next line.

## Firecrawl Search — working

- Query: \`Firecrawl pricing\` (limit 3)
- Result: \`success: true\`, \`3 web results\`
- Top hits:

1. https://www.firecrawl.dev/pricing
2. https://www.firecrawl.dev/
3. [Firecrawl pricing explained](https://scrapegraphai.com/blog/firecrawl-pricing)

- Credits used: 2

## Firecrawl Crawl — working

A paragraph after a heading belongs to that heading's section. Inline \`code\` sits at the body's size, and **bold** and *italic* read as emphasis. See https://example.com/docs for more.

### A smaller heading

10. Tenth item, tabular numerals
11. Eleventh item
12. Twelfth item

> A quote stays quiet.

\`\`\`json
{ "status": "completed", "total": 2 }
\`\`\`

The end.`;

/** The assistant message gets the typography fixture; nothing else about the turn changes. */
async function injectTypography(page) {
  await page.route('**/v1/chats/*/messages*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const m of body.items ?? []) if (m.role === 'assistant') m.parts = m.parts.map((p) => (p.type === 'text' ? { ...p, text: TYPOGRAPHY } : p));
    await route.fulfill({ response, json: body });
  });
}

if (ONLY.has('activity')) for (const scheme of SCHEMES) {
  const { browser, page } = await open(chromium, { scheme });
  const chatId = await scriptedChat(page, 'K2 activity', [['check if fire crawl search and crawl works', 'reasoningInterleaved']]);
  await injectTools(page);
  await page.goto(`${BASE}/c/${chatId}`);
  const toggle = page.getByTestId('agent-activity-toggle').last();
  await toggle.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);
  const turn = page.getByTestId('assistant-turn').last();
  await crop(page, turn, `${TAG}-1-folded-${scheme}`);
  await toggle.click();
  await page.waitForTimeout(700);
  await crop(page, turn, `${TAG}-1-2-open-${scheme}`);
  const header = page.getByTestId('tool-step-header-k2-call');
  await header.click();
  await page.waitForTimeout(700);
  await crop(page, turn, `${TAG}-3-detail-${scheme}`);
  // Icon centre vs the label's x-height centre, per row.
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="tool-step-header-"], [data-testid="reasoning-row"] > button')].map((row) => {
    const svg = row.querySelector('svg');
    const label = row.querySelector('[class*="label"]') ?? row;
    if (!svg) return null;
    const ib = svg.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(label);
    const tb = range.getClientRects()[0];
    const cs = getComputedStyle(label);
    const c = document.createElement('canvas').getContext('2d'); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = c.measureText('x');
    // Baseline from the line box: top + half-leading + ascent.
    const fm = c.measureText('Hg');
    const lh = parseFloat(cs.lineHeight) || tb.height;
    const content = fm.fontBoundingBoxAscent + fm.fontBoundingBoxDescent;
    const baseline = tb.top + (lh - content) / 2 + fm.fontBoundingBoxAscent;
    const xCentre = baseline - m.actualBoundingBoxAscent / 2;
    return { row: row.dataset.testid ?? 'reasoning-row', icon: Math.round((ib.top + ib.height / 2) * 100) / 100, xHeightCentre: Math.round(xCentre * 100) / 100, delta: Math.round((ib.top + ib.height / 2 - xCentre) * 100) / 100, text: row.innerText.slice(0, 80) };
  }).filter(Boolean));
  await writeFile(`${OUT}/${TAG}-2-align-${scheme}.json`, JSON.stringify(rows, null, 2));
  console.log('align', scheme, rows.map((r) => `${r.delta} ${r.text}`).join('\n'));
  await browser.close();
}

if (ONLY.has('type')) for (const scheme of SCHEMES) {
  const { browser, page } = await open(chromium, { scheme });
  const chatId = await scriptedChat(page, 'K2 typography', [['Show me every element', 'text']]);
  await injectTypography(page);
  await page.goto(`${BASE}/c/${chatId}`);
  const msg = page.getByTestId('agent-message-view').last();
  await msg.waitFor();
  await page.waitForTimeout(1200);
  await crop(page, msg, `${TAG}-4-type-${scheme}`, 24);
  const metrics = await page.evaluate(() => {
    const m = document.querySelector('[data-testid="agent-message-view"]');
    const p = m.querySelector('p'); const cs = getComputedStyle(p);
    const h = m.querySelector('h2'); const hs = h ? getComputedStyle(h) : null;
    const code = m.querySelector('code'); const cc = code ? getComputedStyle(code) : null;
    const a = m.querySelector('a'); const as = a ? getComputedStyle(a) : null;
    return { width: m.getBoundingClientRect().width, body: { size: cs.fontSize, lh: cs.lineHeight, color: cs.color, ls: cs.letterSpacing }, heading: hs && { size: hs.fontSize, weight: hs.fontWeight, lh: hs.lineHeight, mt: hs.marginTop, mb: hs.marginBottom }, code: cc && { size: cc.fontSize, bg: cc.backgroundColor, pad: cc.padding, radius: cc.borderRadius }, link: as && { deco: as.textDecorationLine, color: as.textDecorationColor, offset: as.textUnderlineOffset } };
  });
  await writeFile(`${OUT}/${TAG}-4-type-${scheme}.json`, JSON.stringify(metrics, null, 2));
  await browser.close();
}

async function injectConnector(page) {
  const fake = { type: 'connector', id: 'k2-firecrawl', name: 'Firecrawl', url: 'https://mcp.firecrawl.dev/mcp', transport: 'streamableHttp', enabled: true, trusted: true, disabledTools: [], authStatus: 'connected', status: 'connected', toolCount: 34, updatedAt: new Date().toISOString() };
  await page.route('**/v1/connectors*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (Array.isArray(body.items)) body.items = [fake, ...body.items.filter((c) => c.id !== fake.id)];
    await route.fulfill({ response, json: body });
  });
  await page.route('**/v1/bootstrap*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (Array.isArray(body.connectors)) body.connectors = [fake, ...body.connectors];
    await route.fulfill({ response, json: body });
  });
}

if (ONLY.has('tray')) for (const scheme of SCHEMES) {
  const { browser, page } = await open(chromium, { scheme, height: 1000 });
  await injectConnector(page);
  const chatId = await scriptedChat(page, 'K2 tray', [['Show me a long answer', 'long']]);
  await page.goto(`${BASE}/c/${chatId}`);
  await page.getByTestId('assistant-turn').first().waitFor();
  await page.waitForTimeout(800);
  await page.getByTestId('composer-plus-button').click();
  await page.getByTestId('plus-tray').waitFor();
  await page.waitForTimeout(900);
  await crop(page, page.getByTestId('plus-tray'), `${TAG}-5-tray-${scheme}`, 24);
  await browser.close();
}

if (ONLY.has('blur')) {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) for (const scheme of SCHEMES) {
    const { browser, page } = await open(type, { width: 1280, height: 800, scheme });
    const chatId = await scriptedChat(page, 'Firecrawl pricing check', [['Show me every element', 'text'], ['and again', 'text']]);
    await injectTypography(page);
    await page.goto(`${BASE}/c/${chatId}`);
    await page.getByTestId('agent-message-view').first().waitFor();
    if (!(await page.locator('[data-testid="agent-message-view"] h2').first().waitFor({ timeout: 4000 }).then(() => true, () => false))) { await page.reload(); await page.locator('[data-testid="agent-message-view"] h2').first().waitFor(); }
    await page.waitForTimeout(1000);
    // A bright image in the flow, scrolled up under the title.
    const placed = await page.evaluate(async (src) => {
      const img = document.createElement('img'); img.src = src; img.style.cssText = 'display:block;width:100%;height:220px;object-fit:cover;border-radius:12px;margin:12px 0';
      const p = document.querySelectorAll('[data-testid="agent-message-view"] p')[1];
      p.after(img); await img.decode().catch(() => {});
      return true;
    }, `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="220"><defs><linearGradient id="g"><stop offset="0" stop-color="#ffd400"/><stop offset=".5" stop-color="#ff3d6e"/><stop offset="1" stop-color="#2ad4ff"/></linearGradient></defs><rect width="800" height="220" fill="url(#g)"/><text x="40" y="120" font-size="64" font-family="Helvetica" fill="#fff">Bright image</text></svg>')}`);
    for (const [label, sel] of [['text', '[data-testid="agent-message-view"] h2'], ['image', '[data-testid="agent-message-view"] img']]) {
      await page.evaluate((sel) => { const v = document.querySelector('[data-testid="chat-scroll-viewport"]'); const el = document.querySelector(sel); v.scrollTop += el.getBoundingClientRect().top - 20; }, sel);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${TAG}-6-blur-top-${label}-${engine}-${scheme}.png`, clip: { x: 0, y: 0, width: 1280, height: 150 } });
    }
    await page.evaluate(() => { const v = document.querySelector('[data-testid="chat-scroll-viewport"]'); const el = document.querySelector('[data-testid="agent-message-view"] img'); v.scrollTop += el.getBoundingClientRect().bottom - (window.innerHeight - 60); });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${TAG}-6-blur-bottom-${engine}-${scheme}.png`, clip: { x: 0, y: 800 - 190, width: 1280, height: 190 } });
    void placed;
    await browser.close();
  }
}

if (ONLY.has('press')) {
  const { browser, page } = await open(chromium, { scheme: 'dark' });
  await scriptedChat(page, 'Cosmic Compass', [['hi', 'text']]);
  await page.reload(); await page.getByTestId('chat-top-bar').waitFor(); await page.waitForTimeout(600);
  const row = page.locator('[data-sidebar-row]').first();
  const box = await row.boundingBox();
  const side = await page.getByTestId('app-sidebar').boundingBox();
  const clip = { x: side.x, y: Math.max(0, box.y - 120), width: side.width, height: 220 };
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${TAG}-7-press-chat-row.png`, clip });
  const scale = await row.evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.move(box.x + 40, box.y - 300); await page.mouse.up();
  console.log('chat row transform while pressed', scale);
  await writeFile(`${OUT}/${TAG}-7-press.json`, JSON.stringify({ pressedTransform: scale }));
  await browser.close();
}

/** Item 2: the icon's ink centre against the label's x-height band, measured in pixels per row (dpr 4). */
if (ONLY.has('align')) for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) for (const scheme of SCHEMES) {
  const { browser, page } = await open(type, { scheme, dpr: 4 });
  const chatId = await scriptedChat(page, 'K2 align', [['check if fire crawl search and crawl works', 'reasoningInterleaved']]);
  await injectTools(page);
  await page.goto(`${BASE}/c/${chatId}`);
  const toggle = page.getByTestId('agent-activity-toggle').last();
  await toggle.waitFor({ timeout: 15000 });
  await toggle.click();
  await page.waitForTimeout(900);
  await page.mouse.move(5, 5);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="tool-step-header-"], [data-testid="reasoning-row"] > button')].map((row) => {
    const r = row.getBoundingClientRect();
    const icon = row.querySelector('[class*="icon"]').getBoundingClientRect();
    const label = row.querySelector('[class*="label"]');
    const range = document.createRange(); range.selectNodeContents(label);
    const t = range.getClientRects()[0];
    return { name: row.dataset.testid ?? 'reasoning-row', text: label.innerText.slice(0, 40), row: { x: r.x, y: r.y, w: r.width, h: r.height }, icon: { x: icon.x, w: icon.width }, label: { x: t.x, w: Math.min(t.width, 260) } };
  }));
  const out = [];
  for (const row of rows) {
    const buf = await page.screenshot({ clip: { x: row.row.x, y: row.row.y, width: row.row.w, height: row.row.h } });
    const m = await page.evaluate(async ({ b64, row }) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const s = img.width / row.row.w; const d = g.getImageData(0, 0, img.width, img.height).data;
      const lum = (x, y) => { const i = (y * img.width + x) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };
      const bg = lum(img.width - 2, 1);
      const ink = (x, y) => Math.abs(lum(x, y) - bg) > 40;
      const band = (x0, x1) => { const counts = []; for (let y = 0; y < img.height; y++) { let n = 0; for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++) if (ink(x, y)) n++; counts.push(n); } return counts; };
      const ic = band(row.icon.x - row.row.x, row.icon.x - row.row.x + row.icon.w);
      const iTop = ic.findIndex((n) => n > 0), iBot = ic.length - 1 - [...ic].reverse().findIndex((n) => n > 0);
      const tc = band(row.label.x - row.row.x, row.label.x - row.row.x + row.label.w);
      const max = Math.max(...tc); const dense = tc.map((n, y) => (n >= max * 0.45 ? y : -1)).filter((y) => y >= 0);
      const xTop = dense[0], xBot = dense.at(-1);
      return { iconCentre: (iTop + iBot + 1) / 2 / s, xCentre: (xTop + xBot + 1) / 2 / s, xHeight: (xBot - xTop + 1) / s };
    }, { b64: buf.toString('base64'), row });
    out.push({ row: row.name, text: row.text, ...m, delta: Math.round((m.iconCentre - m.xCentre) * 100) / 100 });
  }
  await writeFile(`${OUT}/${TAG}-2-align-px-${engine}-${scheme}.json`, JSON.stringify(out, null, 2));
  console.log(engine, scheme, out.map((o) => `${o.delta.toFixed(2)}  ${o.text}`).join('\n'));
  await browser.close();
}
