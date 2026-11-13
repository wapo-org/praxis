import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
const phase=process.argv[2];const dir=process.env.HOME+'/.praxis-agent-state/cloud/design/M/M2/'+phase;mkdirSync(dir,{recursive:true});
const browser=await chromium.launch();
try {const ctx=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir},serviceWorkers:'block'});const page=await ctx.newPage();
await page.goto('http://127.0.0.1:5262');await page.getByRole('button',{name:'Continue as local dev user'}).click();await page.getByTestId('chat-top-bar').waitFor();
await page.route('**/v1/runs',async route=>{if(route.request().method()!=='POST')return route.continue();await route.continue({postData:JSON.stringify({...route.request().postDataJSON(),providerId:'scripted',modelId:'scripted',script:'helloReplay'})});});
await page.getByTestId('composer-input').fill('say something then execute a tool then say something and then execute a tool then say something');await page.getByTestId('composer-input').press('Enter');
const metrics=[];
for(const [i,delay] of [2500,3000,5000,5000,5000].entries()){await page.waitForTimeout(delay);await page.screenshot({path:dir+'/'+i+'.png'});metrics.push(await page.locator('[data-testid="agent-activity-toggle"], [data-testid="agent-message-view"], [data-timeline-text]').evaluateAll(es=>es.map(e=>({text:e.textContent,top:e.getBoundingClientRect().top}))));}
await page.getByTestId('assistant-turn').waitFor({timeout:30000});await page.getByTestId('agent-activity-toggle').nth(phase === 'after' ? 1 : 0).click();await page.locator('[data-testid^="tool-step-header-"]').first().click();await page.waitForTimeout(500);await page.screenshot({path:dir+'/output.png'});const output=page.locator('section[data-caption="output"] > div').first(); const viewport=page.getByTestId('chat-scroll-viewport');
const wheel={before:{page:await viewport.evaluate(el=>el.scrollTop),inner:await output.evaluate(el=>el.scrollTop)}};
await output.hover();await page.mouse.wheel(0,200);await page.waitForTimeout(400);
wheel.after={page:await viewport.evaluate(el=>el.scrollTop),inner:await output.evaluate(el=>el.scrollTop)};
await page.screenshot({path:dir+'/wheel.png'});writeFileSync(dir+'/wheel.json',JSON.stringify(wheel,null,2));
writeFileSync(dir+'/metrics.json',JSON.stringify(metrics,null,2));await ctx.close();}finally{await browser.close();}
