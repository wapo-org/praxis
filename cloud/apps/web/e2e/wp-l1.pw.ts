import {expect,test} from '@playwright/test';
test.beforeEach(async({page})=>{
 await page.request.post('/v1/auth/dev',{data:{type:'auth.dev',userId:'l1-e2e-'+crypto.randomUUID()}});
 await page.goto('/');await page.getByTestId('composer-input').waitFor();
});
test('regenerating the middle reply keeps one prompt, removes later turns, and survives reload',async({page})=>{
 for(const text of ['Closer','Later turn']){
  await page.getByTestId('composer-input').fill(text);await page.getByTestId('composer-send-button').click();await expect(page.getByTestId('assistant-turn').last()).toContainText('Scripted response: '+text);
 }
 await page.getByTestId('turn-retry-button').first().click();
 await expect(page.getByTestId('assistant-turn')).toHaveCount(1);await expect(page.getByTestId('assistant-turn')).toContainText('Scripted response: Closer');
 await page.reload();await expect(page.getByTestId('assistant-turn')).toHaveCount(1);await expect(page.getByTestId('assistant-turn')).toContainText('Scripted response: Closer');
 await expect(page.locator('body')).not.toContainText('Later turn');
});
for(const action of ['Submit','Decline','Cancel'])test(`${action} removes the pending form in under 100ms despite a delayed response`,async({page})=>{
 await page.getByTestId('composer-input').fill('Start elicitation');await page.getByTestId('composer-send-button').click();
 const form=page.getByTestId('elicitation-form-surface');await form.waitFor();if(action==='Submit')await page.getByTestId('elicitation-input-name').fill('Ada');
 await page.route('**/v1/runs/*/elicitations',async route=>{await new Promise(r=>setTimeout(r,1200));await route.continue();});
 const elapsed=await page.evaluate(async action=>{
  const form=document.querySelector('[data-testid="elicitation-form-surface"]')!;
  const button=[...form.querySelectorAll('button')].find(b=>b.textContent===action)! as HTMLButtonElement;
  const start=performance.now();button.click();while(form.isConnected&&performance.now()-start<5000)await new Promise(requestAnimationFrame);return performance.now()-start;
 },action);
 expect(elapsed).toBeLessThan(100);
 await page.waitForTimeout(1400);await expect(form).toHaveCount(0);
});
