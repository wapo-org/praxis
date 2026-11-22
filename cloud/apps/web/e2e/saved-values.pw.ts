import { apiRequest, openSignedInPage, sessionHeaders, signedInTest as test } from './sign-in';
import {expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
const capture=process.env.K1_CAPTURE_DIR;
test.beforeEach(async({page})=>{
 await openSignedInPage(page);
 await page.getByTestId('composer-input').waitFor();
});

const savedValuePage = z.object({
  items: z.array(z.object({ id: z.string() })),
  nextCursor: z.string().nullable(),
});

test.afterEach(async ({ page }, info) => {
  if (info.status !== 'passed') return;
  const headers = await sessionHeaders(page);
  let hasMore: boolean;
  do {
    const response = await page.request.get('/v1/saved-values', { headers });
    expect(response.ok()).toBe(true);
    const { items, nextCursor } = savedValuePage.parse(await response.json());
    const removed = await Promise.all(items.map(({ id }) =>
      page.request.delete(`/v1/saved-values/${encodeURIComponent(id)}`, { headers })));
    for (const response of removed) expect(response.ok()).toBe(true);
    hasMore = nextCursor !== null;
  } while (hasMore);
});
test('a compact question saves ordinary answers and keeps the title outside its surface',async({page},info)=>{
 await page.getByTestId('composer-input').fill('Start an elicitation');
 await page.getByTestId('composer-send-button').click();
 const surface=page.getByTestId('elicitation-form-surface');
 await expect(surface).toBeVisible();
 await expect(surface).toHaveCSS('border-top-width','0px');
 expect((await surface.boundingBox())!.width).toBeLessThanOrEqual(480);
 expect(await surface.evaluate(el=>el.contains(el.parentElement!.querySelector('p')!))).toBe(false);
 const input=page.getByTestId('elicitation-input-name');
 expect(await input.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe(await surface.evaluate(el=>getComputedStyle(el).backgroundColor));
 await input.fill('Deployment demo');
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.waitForTimeout(250);
  if(capture){await mkdir(capture,{recursive:true});await page.screenshot({path:join(capture,info.project.name+'-question-'+theme+'.png')});}
 }
 await page.getByTestId('elicitation-submit-save').click();
 await expect(page.getByTestId('assistant-turn').last()).toContainText('Scripted tools completed.');
 const items=(await apiRequest(page, 'get', '/v1/saved-values').then(r=>r.json())).items;
 expect(items.find((v:any)=>v.kind==='variable'&&v.name==='name')?.value).toBe('Deployment demo');
});
// WP-L2 (L-ref/10, 15): the forms live in modals under "Add new" and each row's Edit; the list is one line per value.
test('a separate settings page creates, renames and deletes secrets and variables',async({page},info)=>{
 await page.goto('/settings/sharing');
 await expect(page.getByTestId('settings-page')).not.toContainText('Add a saved value');
 await page.goto('/settings/saved-values');
 await expect(page.getByTestId('settings-page')).toHaveAttribute('aria-label','Secrets & variables');
 await expect(page.getByText('No saved values yet.')).toBeVisible();
 await page.getByRole('button',{name:'Add new',exact:true}).click();
 const add=page.getByTestId('saved-value-add');
 await expect(add.getByLabel('Saved value name')).toBeFocused();
 await add.getByLabel('Saved value name').fill('region');
 await add.getByLabel('Saved variable value').fill('eu-west');
 await add.getByRole('button',{name:'Save value',exact:true}).click();
 await expect(add).toHaveCount(0);
 const box=page.getByTestId('saved-values-box');
 await expect(box.getByText('region',{exact:true})).toBeVisible();
 await expect(box.getByText('eu-west')).toBeVisible();
 await page.getByRole('button',{name:'Add new',exact:true}).click();
 await add.getByLabel('Saved value name').fill('deploy_token');
 // Escape closes the opened dropdown menu without closing the <Modal>.
 const typeTrigger=add.getByLabel('Saved value type');
 await typeTrigger.click();
 await expect(add.getByRole('menuitemradio',{name:'Secret',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(add).toBeVisible();
 await expect(add.getByRole('menuitemradio',{name:'Secret',exact:true})).toHaveCount(0);
 await typeTrigger.click();
 await add.getByRole('menuitemradio',{name:'Secret',exact:true}).click();
 const secretInput=add.getByLabel('Saved secret value');
 await secretInput.fill('SYNTHETIC-BROWSER-TOKEN');
 await expect(secretInput).toHaveAttribute('type','password');
 if(capture)await page.screenshot({path:join(capture,info.project.name+'-secret-entry-masked.png')});
 await add.getByRole('button',{name:'Reveal value',exact:true}).click();
 await expect(secretInput).toHaveAttribute('type','text');
 await add.getByRole('button',{name:'Hide value',exact:true}).click();
 await add.getByRole('button',{name:'Save value',exact:true}).click();
 await expect(add).toHaveCount(0);
 await expect(box.getByText('deploy_token',{exact:true})).toBeVisible();
 await expect(page.locator('body')).not.toContainText('SYNTHETIC-BROWSER-TOKEN');
 const items=(await apiRequest(page, 'get', '/v1/saved-values').then(r=>r.json())).items;
 const secret=items.find((v:any)=>v.kind==='secret'),variable=items.find((v:any)=>v.kind==='variable');
 expect(secret).not.toHaveProperty('value');
 await expect(page.getByTestId('saved-value-'+secret.id)).toContainText('••••');
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.waitForTimeout(250);
  if(capture){await mkdir(capture,{recursive:true});await page.screenshot({path:join(capture,info.project.name+'-saved-values-'+theme+'.png')});}
 }
 // Edit: rename and change the value; the dates are shown.
 await page.getByRole('button',{name:'Edit region',exact:true}).click();
 const edit=page.getByTestId('saved-value-edit');
 await expect(edit).toContainText('Added');
 await expect(edit).toContainText('Last used');
 await edit.getByLabel('Name for region').fill('deployment_region');
 await edit.getByLabel('Variable value').fill('us-east');
 await edit.getByRole('button',{name:'Save',exact:true}).click();
 await expect(edit).toHaveCount(0);
 await expect(page.getByTestId('saved-value-'+variable.id)).toContainText('deployment_region');
 await expect(page.getByTestId('saved-value-'+variable.id)).toContainText('us-east');
 // A secret's value is write-only: Replace value, never shown.
 await page.getByRole('button',{name:'Edit deploy_token',exact:true}).click();
 await expect(edit.getByLabel('Replace secret value')).toHaveValue('');
 await edit.getByLabel('Replace secret value').fill('SYNTHETIC-REPLACED');
 await edit.getByRole('button',{name:'Save',exact:true}).click();
 await expect(edit).toHaveCount(0);
 await expect(page.locator('body')).not.toContainText('SYNTHETIC-REPLACED');
 // Delete from inside the modal, after a confirm.
 await page.getByRole('button',{name:'Edit deploy_token',exact:true}).click();
 await edit.getByRole('button',{name:'Delete',exact:true}).click();
 await edit.getByRole('alert').getByRole('button',{name:'Delete',exact:true}).click();
 await expect(page.getByTestId('saved-value-'+secret.id)).toHaveCount(0);
});
test('saved-values box hugs 1 and 3 rows with uniform 8px inner padding on all four sides',async({page})=>{
 await apiRequest(page, 'post', '/v1/saved-values',{data:{name:'api_key_one',kind:'secret',value:'SYNTH-ONE'}});
 await page.goto('/settings/saved-values');
 const box=page.getByTestId('saved-values-box');
 const rows=box.locator('[data-testid^="saved-value-"]:not([data-testid="saved-value-skeleton"])');
 await expect(rows).toHaveCount(1);
 const measure=()=>box.evaluate(el=>{
  const r=el.getBoundingClientRect();
  const rowEls=[...el.querySelectorAll('[data-testid^="saved-value-"]:not([data-testid="saved-value-skeleton"])')];
  const first=rowEls[0]!;
  const last=rowEls[rowEls.length-1]!;
  const cs=getComputedStyle(first);
  const nameRect=first.querySelector('span')!.getBoundingClientRect();
  const firstBtn=first.querySelector('button')!.getBoundingClientRect();
  const lastBtn=last.querySelector('button')!.getBoundingClientRect();
  return {
   boxHeight:Math.round(r.height),
   scrollHeight:el.scrollHeight,
   clientHeight:el.clientHeight,
   padding:[cs.paddingTop,cs.paddingRight,cs.paddingBottom,cs.paddingLeft],
   insets:{
    top:Math.round(firstBtn.top-r.top),
    right:Math.round(r.right-firstBtn.right),
    bottom:Math.round(r.bottom-lastBtn.bottom),
    left:Math.round(nameRect.left-r.left),
   },
  };
 });
 expect(await measure()).toEqual({
  boxHeight:44,
  scrollHeight:44,
  clientHeight:44,
  padding:['8px','8px','8px','8px'],
  insets:{top:8,right:8,bottom:8,left:8},
 });
 await apiRequest(page, 'post', '/v1/saved-values',{data:{name:'api_key_two',kind:'secret',value:'SYNTH-TWO'}});
 await apiRequest(page, 'post', '/v1/saved-values',{data:{name:'deploy_region',kind:'variable',value:'us-east-1'}});
 await page.reload();
 await expect(rows).toHaveCount(3);
 expect(await measure()).toEqual({
  boxHeight:132,
  scrollHeight:132,
  clientHeight:132,
  padding:['8px','8px','8px','8px'],
  insets:{top:8,right:8,bottom:8,left:8},
 });
});
test('an unavailable endpoint shows recovery without claiming the account is empty',async({page},info)=>{
 await page.addInitScript(()=>{
  (window as any).__savedValuesReady=false;
  const original=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
   const url=typeof input==='string'?input:input instanceof Request?input.url:String(input);
   if(/\/v1\/saved-values(\?|$)/.test(url)&&!(window as any).__savedValuesReady)return new Response(JSON.stringify({message:'Endpoint not found'}),{status:404,headers:{'content-type':'application/json'}});
   return original(input,init);
  };
 });
 await page.goto('/settings/saved-values');
 await expect(page.getByText('Saved values are not available on this server yet. Update the server, then retry.')).toBeVisible();
 await expect(page.getByText('No saved values yet.')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Add new',exact:true})).toBeDisabled();
 if(capture)await page.screenshot({path:join(capture,info.project.name+'-server-unavailable.png')});
 await page.evaluate(()=>{(window as any).__savedValuesReady=true;});
 await page.getByRole('button',{name:'Retry loading'}).click();
 await expect(page.getByRole('button',{name:'Add new',exact:true})).toBeEnabled();
 await expect(page.getByText('No saved values yet.')).toBeVisible();
});
// WP-L2: 300 values page in lazily inside the box, search narrows on the server, the filters apply.
test('three hundred values: lazy pages in a self-scrolling box, search and filters',async({page})=>{
 test.setTimeout(120000);
 for(let i=0;i<300;i++){
  const secret=i%4===0;
  await apiRequest(page, 'post', '/v1/saved-values',{data:{name:(secret?'token_':'var_')+String(i).padStart(3,'0'),kind:secret?'secret':'variable',value:secret?'SYNTH-'+i:'value '+i}});
 }
 await page.goto('/settings/saved-values');
 const box=page.getByTestId('saved-values-box');
 const rows=box.locator('[data-testid^="saved-value-"]:not([data-testid="saved-value-skeleton"])');
 await expect(rows).toHaveCount(40);
 const geometry=await box.evaluate(el=>({scrolls:el.scrollHeight>el.clientHeight+10,overflow:getComputedStyle(el).overflowY,radius:parseFloat(getComputedStyle(el).borderTopLeftRadius)}));
 expect(geometry).toEqual({scrolls:true,overflow:'auto',radius:22});
 for(let n=0;n<12;n++){await box.evaluate(el=>el.scrollTo({top:el.scrollHeight}));await page.waitForTimeout(150);}
 await expect.poll(()=>rows.count(),{timeout:15000}).toBe(300);
 await page.getByLabel('Search saved values').fill('var_12');
 // var_120 … var_129 without the tokens (every fourth index): seven.
 await expect.poll(()=>rows.count()).toBe(7);
 for(const text of await rows.allTextContents())expect(text).toContain('var_12');
 await page.getByLabel('Search saved values').fill('');
 await page.getByRole('button',{name:'Secrets',exact:true}).click();
 await expect.poll(()=>rows.count()).toBe(40);
 expect(await box.getByText('Variable',{exact:true}).count()).toBe(0);
 await page.getByRole('button',{name:'Variables',exact:true}).click();
 await expect.poll(async()=>(await box.getByText('Secret',{exact:true}).count())===0&&await rows.count()===40).toBe(true);
 await page.getByRole('button',{name:'Added this week',exact:true}).click();
 await expect.poll(()=>rows.count()).toBe(40);
 await page.getByRole('button',{name:'Unused',exact:true}).click();
 await expect.poll(()=>rows.count()).toBeGreaterThanOrEqual(40);
});
