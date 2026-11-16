import {expect,test} from '@playwright/test';
test.beforeEach(async({page})=>{
 await page.request.post('/v1/auth/dev',{data:{type:'auth.dev',userId:'m3-spec-'+Date.now()}});
});
test('generated titles remain one line in header and sidebar for the real requests',async({page})=>{
 for(const text of ['say something then execute a tool then say something and then execute a tool then say something','write something semi long','write omething semi long']){
  const chat=await page.request.post('/v1/chats',{data:{type:'chat.input'}}).then(r=>r.json());
  await page.request.post('/v1/runs',{data:{type:'run.start',chatId:chat.id,text}});
  await page.goto('/c/'+chat.id);
  const header=page.getByTestId('nav-chat-title-pill');await expect(header).not.toContainText('New chat');
  const title=await page.request.get('/v1/chats/'+chat.id).then(r=>r.json()).then(c=>c.title);
  expect(title).not.toMatch(/[\r\n]/);expect(title.length).toBeLessThanOrEqual(48);
  await expect(header).toContainText(title);
  const sidebar=page.getByRole('complementary',{name:'Conversation history'});
  await expect(sidebar.getByText(title,{exact:true})).toBeVisible();
  for(const label of [header.locator('span').filter({hasText:title}).last(),sidebar.getByText(title,{exact:true})]){
   const lines=await label.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return new Set([...range.getClientRects()].map(r=>Math.round(r.y))).size;});expect(lines).toBe(1);
  }
 }
});
for(const count of [1,3,30])test(`${count} saved values hug rows with equal outer padding`,async({page})=>{
 for(let i=0;i<count;i++)await page.request.post('/v1/saved-values',{data:{name:'m3_value_'+i,kind:i===0?'secret':'variable',value:'synthetic'}});
 await page.goto('/settings/saved-values');const box=page.getByTestId('saved-values-box');
 await expect(box.locator('[data-testid^="saved-value-"]:not([data-testid="saved-value-skeleton"])')).toHaveCount(count);
 for(const theme of ['light','dark']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  const m=await box.evaluate(el=>{const s=getComputedStyle(el),rows=[...el.querySelectorAll('[data-testid^="saved-value-"]')];return {height:el.getBoundingClientRect().height,rowHeight:rows.reduce((n,r)=>n+r.getBoundingClientRect().height,0),padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft].map(parseFloat),scrolls:el.scrollHeight>el.clientHeight};});
  expect(new Set(m.padding).size).toBe(1);
  if(count<30)expect(m.height).toBeCloseTo(m.rowHeight+2*m.padding[0],0);else expect(m.scrolls).toBe(true);
 }
});
