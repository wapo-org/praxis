import { chromium, expect } from '@playwright/test';
import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import sharp from 'sharp';
import { record } from './g2-lib.mjs';
const OUT = `${homedir()}/.praxis-agent-state/cloud/design/G3/C`;
const BASE = process.env.BASE ?? 'http://127.0.0.1:5251';
const b = await chromium.launch();
try {
  const context = await b.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT } });
  const p = await context.newPage();
  await p.goto(BASE);
  await p.getByRole('button', { name: /local dev user/i }).click();
  await p.getByTestId('chat-screen').waitFor();
  const palette = p.getByTestId('search-palette');
  const input = palette.getByRole('combobox');
  const clips = [
    ['open', async () => { await p.keyboard.press('Meta+k'); }],
    ['first-results', async () => { await input.fill('Привет'); await expect(palette.getByRole('option').first()).toBeVisible(); }],
    ['results-change', async () => { await input.fill('reasoning'); }],
    ['clearing', async () => { await input.fill(''); }],
    ['close', async () => { await input.press('Escape'); }],
  ];
  for (const [name, act] of clips) {
    const dir = `${OUT}/frames/${name}`;
    await mkdir(dir, { recursive: true });
    await record(p, dir, name, async () => { await act(); await p.waitForTimeout(450); });
    const files = (await readdir(dir)).filter(n => n.endsWith('.jpg')).sort();
    const chosen = Array.from({ length: 6 }, (_, i) => files[Math.round(i * (files.length - 1) / 5)]);
    const tiles = await Promise.all(chosen.map(async (file, i) => ({ input: await sharp(`${dir}/${file}`).extract({ left: 370, top: 65, width: 700, height: 620 }).resize(350, 310).png().toBuffer(), top: 0, left: i * 350 })));
    await sharp({ create: { width: 2100, height: 310, channels: 4, background: '#eee' } }).composite(tiles).png().toFile(`${OUT}/frames-${name}.png`);
  }
  const rows = await Promise.all(clips.map(async ([name], i) => ({ input: await sharp(`${OUT}/frames-${name}.png`).png().toBuffer(), left: 0, top: i * 310 })));
  await sharp({ create: { width: 2100, height: 1550, channels: 4, background: '#eee' } }).composite(rows).png().toFile(`${OUT}/motion-frame-sheet.png`);
  await context.close();
} finally { await b.close(); }
