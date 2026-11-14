// WP-H3: search captures through the real local API (semantic) and a long result list (padding).
// BASE=http://127.0.0.1:5232 OUT=... node apps/web/scripts/h3-search-capture.mjs
import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5232';
const OUT = process.env.OUT ?? '/tmp/h3-raw';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
await context.request.post(BASE + '/v1/auth/dev', { data: { type: 'auth.dev' } });
const chats = await (await context.request.get(BASE + '/v1/chats?limit=100')).json();
for (const chat of chats.items) await context.request.delete(BASE + '/v1/chats/' + chat.id);
const seed = [
  ['Trip packing list', 'Packing list for 3 days in Lisbon'],
  ['Regex help', 'Match a date like 2026-11-07'],
  ['New chat4et', 'fhfgj'],
  ['Kettle descaling', 'How do I descale a kettle with vinegar?'],
  ['Budget review', 'Monthly spending went up in October'],
  ['SQL joins', 'Explain a left join with an example'],
];
for (const [title, text] of seed) {
  const chat = await (await context.request.post(BASE + '/v1/chats', { data: { type: 'chat.input', title } })).json();
  await context.request.post(BASE + '/v1/runs', { data: { type: 'run.start', chatId: chat.id, text } });
}
const page = await context.newPage();
await page.addInitScript(() => localStorage.setItem('praxis-theme', 'light'));
await page.goto(BASE + '/');
await page.getByTestId('chat-top-bar').waitFor();
await page.waitForTimeout(2500); // the runs finish and the index settles
for (const [i, query] of ['how to pack for a trip', 'date regex', 'how much did I spend'].entries()) {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('search-palette');
  await palette.getByRole('combobox').fill(query);
  await palette.getByRole('option').first().waitFor();
  await page.waitForTimeout(700);
  const box = await palette.boundingBox();
  await page.screenshot({ path: `${OUT}/search-semantic-${i}.png`, clip: { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 } });
  await page.keyboard.press('Escape');
  await page.getByTestId('search-palette').waitFor({ state: 'detached' });
}
await page.route('**/v1/search?**', route => route.fulfill({ json: { type: 'page', nextCursor: null,
  items: Array.from({ length: 24 }, (_, i) => ({ chat: { id: `pad-${i}`, title: `Result ${i + 1}` }, snippet: `Matching context for result ${i + 1}` })) } }));
for (const [name, end] of [['top', false], ['end', true]]) {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('search-palette');
  await palette.getByRole('combobox').fill('Result');
  await palette.getByRole('option').last().waitFor();
  await page.waitForTimeout(700);
  if (end) await palette.getByRole('listbox').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  const box = await palette.boundingBox();
  await page.screenshot({ path: `${OUT}/search-padding-${name}.png`, clip: { x: box.x - 16, y: box.y + box.height - 220, width: box.width + 32, height: 236 } });
  await page.keyboard.press('Escape');
  await page.getByTestId('search-palette').waitFor({ state: 'detached' });
}
await browser.close();
console.log('ok');
