import { chromium } from '@playwright/test';
const b = await chromium.launch();
for (const [w, h] of [[1440, 900], [402, 874]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:5232'); const d = p.getByRole('button', { name: 'Continue as local dev user' }); await d.waitFor(); await d.click(); await p.getByTestId('chat-top-bar').waitFor();
  const id = await p.evaluate(async () => { const { apiClient } = await import('/src/lib/api.ts'); const c = await apiClient.createChat({ title: 'Settings probe' }); await apiClient.startRun({ chatId: c.id, text: 'long text please', script: 'long', providerId: 'scripted', modelId: 'scripted', clientTurnId: crypto.randomUUID() }); return c.id; });
  await p.goto(`http://127.0.0.1:5232/c/${id}`); await p.getByTestId('assistant-turn').first().waitFor(); await p.waitForTimeout(3000);
  await p.evaluate(() => { history.pushState({}, '', '/settings/sharing'); dispatchEvent(new PopStateEvent('popstate')); });
  for (const t of [50, 200, 1500]) { await p.waitForTimeout(t); await p.screenshot({ path: `/tmp/j2/settings-${w}-${t}.png` }); console.log(w, t, p.url(), 'chat mounted:', await p.locator('[data-testid="chat-screen"]').count()); }
  await ctx.close();
}
await b.close();
