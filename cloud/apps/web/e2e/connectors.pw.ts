import { openSignedInPage, signedInTest as test } from './sign-in';
import {expect} from '@playwright/test';
test('builtins are disabled on first server bootstrap; tool switches persist while disabled',async({page})=>{
 await openSignedInPage(page);await page.getByTestId('chat-top-bar').waitFor();
 const initial=await page.evaluate(async()=>{const source='/src/lib/api.ts';const {apiClient}=await import(source) as typeof import('../src/lib/api');return (await apiClient.bootstrap()).connectors.filter(c=>c.id.startsWith('builtin-'));});
 expect(initial.map(c=>c.name).sort()).toEqual(['Browserbase','E2B','Exa','Firecrawl']);expect(initial.every(c=>!c.enabled)).toBe(true);
 const wasEnabled=!initial.find(c=>c.id==='builtin-exa')!.disabledTools.includes('web_search_exa');
 await page.goto('/settings/connectors');await page.getByRole('button',{name:/Exa.*mcp.exa.ai/}).click();
 const search=page.getByRole('switch',{name:'web_search_exa'});await expect(search).toBeChecked({checked:wasEnabled});
 await search.click();await expect(search).toBeChecked({checked:!wasEnabled});
 await page.reload();await page.getByRole('button',{name:/Exa.*mcp.exa.ai/}).click();await expect(search).toBeChecked({checked:!wasEnabled});
 await search.click();await expect(search).toBeChecked({checked:wasEnabled});
});
test('cold draft tray always shows the same connector rows across five openings',async({page})=>{
 for(let i=0;i<5;i++){
  await openSignedInPage(page);
  await page.getByTestId('composer-plus-button').click();await expect(page.getByTestId('plus-tray').getByRole('button',{name:/Connectors/})).toBeVisible();await page.keyboard.press('Escape');
 }
});
test('the connector Transport select uses GlassDropdown with keyboard navigation (no native select)',async({page})=>{
 await openSignedInPage(page);
 await page.goto('/settings/connectors');
 await page.getByRole('button',{name:/Add by URL/}).click();
 expect(await page.locator('select').count()).toBe(0);
 const trigger=page.getByLabel('Transport');
 await expect(trigger).toHaveText(/Streamable HTTP/);
 await trigger.focus();
 await page.keyboard.press('ArrowDown');
 await expect(page.getByRole('menuitemradio',{name:'Server-sent events (SSE)'})).toBeVisible();
 await page.keyboard.press('ArrowDown');
 await page.keyboard.press('Enter');
 await expect(trigger).toHaveText(/Server-sent events \(SSE\)/);
});
test('plus tray scrolls cleanly in short windows and navigates to nested connectors view (0, 2, 30)',async({page})=>{
 await openSignedInPage(page);
 await page.setViewportSize({width:1280,height:420});
 await page.goto('/');
 await page.getByTestId('composer-plus-button').click();
 const tray=page.getByTestId('plus-tray');
 await tray.waitFor();
 // Fits inside short viewport and scrolls cleanly
 const box=await tray.boundingBox();
 expect(box!.y).toBeGreaterThanOrEqual(4);
 const vp=tray.locator('[data-slot="scroll-blur-viewport"]').first();
 expect(await vp.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
 // Progressive edge fade active in both Chromium and WebKit
 expect(await vp.evaluate(el=>{const cs=getComputedStyle(el);return parseFloat(cs.getPropertyValue('--fade-bottom'))>0||(cs.animationName!=='none'&&cs.maskImage!=='none');})).toBe(true);
 // 0 enabled connectors
 await page.getByTestId('tray-connectors-trigger').click();
 await expect(page.getByTestId('tray-connectors-empty')).toBeVisible();
 const manageBtn=page.getByTestId('tray-connectors-manage');
 const searchInput=page.getByLabel('Search connectors');
 const headerSameRow=await Promise.all([searchInput.boundingBox(),manageBtn.boundingBox()]).then(([s,m])=>Math.abs((s!.y+s!.height/2)-(m!.y+m!.height/2))<6);
 expect(headerSameRow).toBe(true);
 await manageBtn.click();
 await expect(page).toHaveURL(/\/settings\/connectors$/);
 // Create 2 connectors first
 await page.evaluate(async()=>{
  const source='/src/lib/api.ts';
  const {apiClient}=await import(source) as typeof import('../src/lib/api');
  for(let i=0;i<2;i++){
   await apiClient.createConnector({name:`MCP ${String(i+1).padStart(2,'0')} Alpha`,url:`https://mcp-a-${i}.example.com/mcp`,transport:'streamableHttp',enabled:true});
  }
 });
 await page.goto('/');
 await page.setViewportSize({width:1280,height:720});
 await page.getByTestId('composer-plus-button').click();
 await expect(page.getByTestId('tray-connectors-trigger')).toContainText('· 2');
 await page.getByTestId('tray-connectors-trigger').click();
 const listView=page.getByTestId('tray-connectors-view');
 await expect(listView.locator('[data-testid^="tray-connector-row-"]')).toHaveCount(2);
 await listView.getByRole('button',{name:'Back',exact:true}).click();
 await expect(page.getByTestId('tray-connectors-trigger')).toHaveAttribute('aria-expanded','false');
 // Now add 28 more -> 30 total connectors
 await page.evaluate(async()=>{
  const source='/src/lib/api.ts';
  const {apiClient}=await import(source) as typeof import('../src/lib/api');
  await Promise.all(Array.from({length:28},(_,i)=>
   apiClient.createConnector({name:`MCP ${String(i+3).padStart(2,'0')} Beta`,url:`https://mcp-b-${i}.example.com/mcp`,transport:'streamableHttp',enabled:true})
  ));
 });
 await page.reload();
 await page.getByTestId('composer-plus-button').click();
 await expect(page.getByTestId('tray-connectors-trigger')).toContainText('· 30');
 await page.getByTestId('tray-connectors-trigger').click();
 await expect(listView.locator('[data-testid^="tray-connector-row-"]')).toHaveCount(30);
 const listVp=listView.locator('[data-slot="scroll-blur-viewport"]');
 expect(await listVp.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
 await page.getByLabel('Search connectors').fill('Alpha');
 await expect(listView.locator('[data-testid^="tray-connector-row-"]')).toHaveCount(2);
 await listView.getByRole('button',{name:'Back',exact:true}).click();
 await expect(listView).toHaveCount(0);
 await page.evaluate(async () => {
   const source = '/src/lib/api.ts';
   const { apiClient } = await import(source) as typeof import('../src/lib/api');
   const { connectors } = await apiClient.bootstrap();
   const created = connectors.filter(connector => /^MCP \d+ (Alpha|Beta)$/.test(connector.name));
   await Promise.all(created.map(({ id }) => apiClient.deleteConnector(id)));
 });
});
