import {test,expect,type Page} from '@playwright/test';
const paragraph='A careful release keeps the reader in control. Check the evidence and keep the next action clear.';
async function signIn(page:Page){await page.goto('/');await page.getByRole('button',{name:'Continue as local dev user'}).waitFor();await page.getByRole('button',{name:'Continue as local dev user'}).click();await page.getByTestId('chat-top-bar').waitFor();}
async function seed(page:Page,script:'text'|'long'='text'){
  const id=await page.evaluate(async({script,text})=>{
    // @ts-expect-error Vite source import.
    const {apiClient}=await import('/src/lib/api.ts');
    const chat=await apiClient.createChat({title:'H2 scroll regression'});
    await apiClient.startRun({chatId:chat.id,text,script});return chat.id;
  },{script,text:script==='long'?'Stream while I read above.':Array(20).fill(paragraph).join('\n\n')});
  await page.goto(`/c/${id}`);await page.getByTestId('chat-top-bar').waitFor();return id;
}
const metrics=(page:Page)=>page.getByTestId('chat-scroll-viewport').evaluate(el=>({overflow:el.scrollHeight-el.clientHeight,distance:el.scrollHeight-el.clientHeight-el.scrollTop,top:el.scrollTop}));
test.beforeEach(async({page})=>signIn(page));
test('a short chat never shows Jump to latest, including after a resize',async({page})=>{
  const input=page.getByTestId('composer-input');await input.fill('A short answer');await input.press('Enter');
  await page.getByTestId('turn-copy-button').last().waitFor();
  await expect(page.getByTestId('jump-to-latest-button')).toBeHidden();
  await page.setViewportSize({width:1440,height:1100});
  await expect(page.getByTestId('jump-to-latest-button')).toBeHidden();
  expect((await metrics(page)).distance).toBeLessThanOrEqual(4);
  if(process.env.H2_CAPTURE_DIR)await page.screenshot({path:`${process.env.H2_CAPTURE_DIR}/jump-short-${test.info().project.name}.png`});
});
test('scrolling up reveals the jump and scrolling down hides it',async({page})=>{
  await seed(page);await page.getByTestId('turn-copy-button').last().waitFor();
  const viewport=page.getByTestId('chat-scroll-viewport');await viewport.evaluate(el=>el.scrollTop=0);
  await expect(page.getByTestId('jump-to-latest-button')).toBeVisible();
  if(process.env.H2_CAPTURE_DIR)await page.screenshot({path:`${process.env.H2_CAPTURE_DIR}/jump-reading-above-${test.info().project.name}.png`});
  await viewport.evaluate(el=>el.scrollTop=el.scrollHeight);
  await expect(page.getByTestId('jump-to-latest-button')).toBeHidden();
});
test('streaming follows only at the bottom; reading above stays anchored, clicking resumes',async({page})=>{
  await seed(page,'long');
  await expect.poll(async()=>(await metrics(page)).overflow).toBeGreaterThan(400);
  await expect.poll(async()=>(await metrics(page)).distance).toBeLessThanOrEqual(4);
  await page.getByTestId('chat-scroll-viewport').evaluate(el=>el.scrollTop=0);
  await expect(page.getByTestId('jump-to-latest-button')).toBeVisible();
  const before=await page.getByTestId('agent-message-view').last().getAttribute('data-revealed');
  await expect.poll(()=>page.getByTestId('agent-message-view').last().getAttribute('data-revealed')).not.toBe(before);
  expect((await metrics(page)).top).toBeLessThanOrEqual(1);
  await page.getByTestId('jump-to-latest-button').click();
  await expect(page.getByTestId('jump-to-latest-button')).toBeHidden();
  await expect.poll(async()=>(await metrics(page)).distance).toBeLessThanOrEqual(4);
  if(process.env.H2_CAPTURE_DIR)await page.screenshot({path:`${process.env.H2_CAPTURE_DIR}/jump-resumed-${test.info().project.name}.png`});
});
test('switching to a new chat clears the old jump state',async({page})=>{
  await seed(page);await page.getByTestId('turn-copy-button').last().waitFor();
  await page.getByTestId('chat-scroll-viewport').evaluate(el=>el.scrollTop=0);
  await expect(page.getByTestId('jump-to-latest-button')).toBeVisible();
  await page.getByTestId('nav-new-chat-desktop').click();
  await expect(page.getByTestId('jump-to-latest-button')).toBeHidden();
  await expect(page.getByTestId('agent-message-view')).toHaveCount(0);
});
test('resizing to fit the content removes the jump without a scroll event',async({page})=>{
  await seed(page);await page.getByTestId('turn-copy-button').last().waitFor();
  await page.getByTestId('chat-scroll-viewport').evaluate(el=>el.scrollTop=0);
  await expect(page.getByTestId('jump-to-latest-button')).toBeVisible();
  const height=await page.getByTestId('chat-scroll-viewport').evaluate(el=>Math.ceil(el.scrollHeight+300));
  await page.setViewportSize({width:1440,height});
  await expect(page.getByTestId('jump-to-latest-button')).toBeHidden();
  expect((await metrics(page)).overflow).toBeLessThanOrEqual(4);
});
