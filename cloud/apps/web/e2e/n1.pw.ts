import { signIn as convexSignIn } from './sign-in';
import { expect, test, type Page } from '@playwright/test';
test.use({ serviceWorkers: 'allow' });

test('regenerate resets Working and persists only the new run duration after reload',async({page})=>{
 await convexSignIn(page);
 await page.route('**/v1/runs',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  return route.continue({postData:JSON.stringify({...route.request().postDataJSON(),providerId:'scripted',modelId:'scripted',script:'realShape'})});
 });
 await page.getByTestId('composer-input').fill('Timer reset');await page.getByTestId('composer-input').press('Enter');
 const inspected=page.locator('[data-testid="live-run-streaming-turn"] button[aria-expanded]').first();
 await inspected.waitFor();await inspected.click();
 await page.getByTestId('turn-retry-button').last().waitFor({timeout:30000});
 await expect(inspected).toHaveAttribute('aria-expanded','true');
 await page.waitForTimeout(3000);
 await page.getByTestId('turn-retry-button').last().click();
 await expect(page.getByTestId('live-run-streaming-turn')).toContainText(/Working\s*·\s*[01]s/);
 await page.getByTestId('turn-retry-button').last().waitFor({timeout:30000});
 const saved=await page.locator('[data-chat-column] button[aria-expanded]').allTextContents();
 await page.reload();await page.getByTestId('turn-retry-button').last().waitFor();
 await expect.poll(()=>page.locator('[data-chat-column] button[aria-expanded]').allTextContents()).toEqual(saved);
});
test('a completed burst drains through word-sized frames instead of snapping into the transcript',async({page})=>{
 await convexSignIn(page);
 await page.route('**/v1/runs',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  return route.continue({postData:JSON.stringify({...route.request().postDataJSON(),providerId:'scripted',modelId:'scripted',script:'bursty'})});
 });
 await page.getByTestId('composer-input').fill('Bursty reveal');await page.getByTestId('composer-input').press('Enter');
 await page.waitForTimeout(900);
 const sizes=await page.evaluate(()=>new Promise<number[]>(resolve=>{
  const samples:number[]=[];const start=performance.now();
  const tick=()=>{samples.push(Array.from(document.querySelectorAll('[data-timeline-text]')).map(e=>e.textContent??'').join('').length);if(performance.now()-start<4000)requestAnimationFrame(tick);else resolve(samples);};tick();
 }));
 expect(new Set(sizes).size).toBeGreaterThan(20);
 const positive=sizes.slice(1).map((v,i)=>v-sizes[i]!).filter(v=>v>0);
 expect(positive.filter(v=>v<80).length/positive.length).toBeGreaterThan(.8);
 await page.getByTestId('turn-retry-button').last().waitFor({timeout:30000});
});
test('real-shaped disclosures stay fixed at bottom, above and while streaming',async({page})=>{
 await convexSignIn(page);
 const id=await page.evaluate(async()=>{
  // @ts-expect-error Vite import
  const {apiClient}=await import('/src/lib/api.ts');
  const chat=await apiClient.createChat({title:'N1 disclosure'});await apiClient.startRun({chatId:chat.id,text:'Real shape tools',script:'realShape'});return chat.id;
 });
 await page.goto(`/c/${id}`);await page.getByTestId('assistant-turn').last().waitFor({timeout:30000});
 const viewport=page.getByTestId('chat-scroll-viewport');
 const closed=page.locator('[data-chat-column] button[aria-expanded="false"]');
 expect(await closed.count()).toBeGreaterThan(0);
 const measure=async(control:ReturnType<Page['locator']>,scenario:string)=>{
  const drift=await control.evaluate(el=>new Promise<number>(resolve=>{
   const top=el.getBoundingClientRect().top,start=performance.now();let drift=0;
   const tick=()=>{drift=Math.max(drift,Math.abs(el.getBoundingClientRect().top-top));if(performance.now()-start<700)requestAnimationFrame(tick);else resolve(drift);};(el as HTMLElement).click();requestAnimationFrame(tick);
  }));console.log(`N1 ${scenario} disclosure drift: ${drift}px`);expect(drift).toBeLessThanOrEqual(1);
 };
 await viewport.evaluate(el=>el.scrollTop=el.scrollHeight);
 await closed.last().scrollIntoViewIfNeeded();await measure(closed.last(),'bottom');
 await closed.first().evaluate(el=>el.scrollIntoView({block:'center'}));await measure(closed.first(),'reading above');
 await page.evaluate(async(id)=>{
  // @ts-expect-error Vite import
  const {apiClient}=await import('/src/lib/api.ts');
  await apiClient.startRun({chatId:id,text:'Continue streaming',script:'long'});
 },id);
 await page.reload();await page.getByTestId('composer-stop-button').waitFor();
 await closed.first().evaluate(el=>el.scrollIntoView({block:'center'}));await measure(closed.first(),'streaming');
 await page.getByTestId('composer-stop-button').click();
});
test('a message sent before the model list loads waits for the model instead of failing the new chat',async({page})=>{
 await page.route(/\/v1\/bootstrap/,async route=>{await new Promise(r=>setTimeout(r,2500));await route.continue();});
 const chatPosts:{status:number;body:string}[]=[];const runBodies:string[]=[];
 page.on('response',r=>{if(r.url().endsWith('/v1/chats')&&r.request().method()==='POST')chatPosts.push({status:r.status(),body:r.request().postData()??''});});
 page.on('request',r=>{if(r.url().endsWith('/v1/runs')&&r.method()==='POST')runBodies.push(r.postData()??'');});
 await convexSignIn(page);await page.getByTestId('chat-top-bar').waitFor();
 await page.getByTestId('composer-input').fill('Sent before models');await page.getByTestId('composer-input').press('Enter');
 await expect(page.getByTestId('user-message-bubble').last()).toContainText('Sent before models');
 await page.getByTestId('turn-retry-button').last().waitFor({timeout:30000});
 expect(chatPosts).toHaveLength(1);expect(chatPosts[0]!.status).toBe(201);
 expect(JSON.parse(chatPosts[0]!.body).providerId).toBeTruthy();
 expect(JSON.parse(runBodies[0]!).modelId).toBeTruthy();
 await expect(page.getByText('no longer available')).toHaveCount(0);
});
