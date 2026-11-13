import {test,expect} from '@playwright/test';
test('builtins are disabled on first server bootstrap; tool switches persist while disabled',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Continue as local dev user'}).waitFor();await page.getByRole('button',{name:'Continue as local dev user'}).click();await page.getByTestId('chat-top-bar').waitFor();
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
  await page.goto('/');const login=page.getByRole('button',{name:'Continue as local dev user'});await expect(login.or(page.getByTestId('chat-top-bar')).first()).toBeVisible();if(await login.isVisible())await login.click();await page.getByTestId('chat-top-bar').waitFor();
  await page.getByTestId('composer-plus-button').click();await expect(page.getByTestId('plus-tray').getByRole('button',{name:/Connectors/})).toBeVisible();await page.keyboard.press('Escape');
 }
});
test('connector Transport and provider Flavor selects use GlassDropdown with keyboard navigation (no native select)',async({page})=>{
 await page.request.post('/v1/auth/dev',{data:{type:'auth.dev',userId:'select-check-'+Date.now()}});
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
 await page.goto('/settings/providers');
 await page.getByRole('button',{name:'Add provider'}).click();
 const flavor=page.getByLabel('Flavor');
 await expect(flavor).toBeVisible();
 expect(await page.locator('select').count()).toBe(0);
 await flavor.click();
 await page.getByRole('menuitemradio',{name:'OpenAI Responses'}).click();
 await expect(flavor).toHaveText(/OpenAI Responses/);
});
