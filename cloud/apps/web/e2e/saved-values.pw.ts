import {expect,test} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const capture=process.env.K1_CAPTURE_DIR;
test.beforeEach(async({page})=>{
 await page.request.post('/v1/auth/dev',{data:{type:'auth.dev',userId:'saved-values-'+Date.now()}});
 await page.goto('/');
 await page.getByTestId('composer-input').waitFor();
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
 const items=(await page.request.get('/v1/saved-values').then(r=>r.json())).items;
 expect(items.find((v:any)=>v.kind==='variable'&&v.name==='name')?.value).toBe('Deployment demo');
});
test('a separate settings page creates, renames and deletes secrets and variables',async({page},info)=>{
 await page.goto('/settings/sharing');
 await expect(page.getByTestId('settings-page')).not.toContainText('Add a saved value');
 await page.goto('/settings/saved-values');
 await expect(page.getByTestId('settings-page')).toHaveAttribute('aria-label','Secrets & variables');
 await expect(page.getByLabel('Saved value name')).toBeEnabled();
 await page.getByLabel('Saved value name').fill('region');
 await page.getByLabel('Saved variable value').fill('eu-west');
 await page.getByRole('button',{name:'Save value',exact:true}).click();
 await expect(page.getByLabel('Name for region')).toBeVisible();
 await page.getByLabel('Saved value name').fill('deploy_token');
 await page.getByLabel('Saved value type').selectOption('secret');
 const secretInput=page.getByLabel('Saved secret value');
 await secretInput.fill('SYNTHETIC-BROWSER-TOKEN');
 await expect(secretInput).toHaveAttribute('type','password');
 if(capture)await page.screenshot({path:join(capture,info.project.name+'-secret-entry-masked.png')});
 await page.getByRole('button',{name:'Reveal value',exact:true}).click();
 await expect(secretInput).toHaveAttribute('type','text');
 if(capture)await page.screenshot({path:join(capture,info.project.name+'-secret-entry-revealed.png')});
 await page.getByRole('button',{name:'Hide value',exact:true}).click();
 await page.getByRole('button',{name:'Save value',exact:true}).click();
 await expect(page.getByLabel('Name for deploy_token')).toBeVisible();
 await expect(page.getByLabel('Saved secret value')).toHaveValue('');
 await expect(page.locator('body')).not.toContainText('SYNTHETIC-BROWSER-TOKEN');
 const items=(await page.request.get('/v1/saved-values').then(r=>r.json())).items;
 const secret=items.find((v:any)=>v.kind==='secret'),variable=items.find((v:any)=>v.kind==='variable');
 expect(secret).not.toHaveProperty('value');
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.waitForTimeout(250);
  if(capture){await mkdir(capture,{recursive:true});await page.screenshot({path:join(capture,info.project.name+'-saved-values-'+theme+'.png')});}
 }
 const row=page.getByTestId('saved-value-'+variable.id);
 await row.getByRole('textbox').fill('deployment_region');
 await row.getByRole('button',{name:'Rename',exact:true}).click();
 await expect(page.getByLabel('Name for deployment_region')).toBeVisible();
 await page.getByTestId('saved-value-'+secret.id).getByRole('button',{name:'Delete',exact:true}).click();
 await expect(page.getByLabel('Name for deploy_token')).toHaveCount(0);
});
test('an unavailable endpoint shows recovery without claiming the account is empty',async({page},info)=>{
 await page.addInitScript(()=>{
  (window as any).__savedValuesReady=false;
  const original=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
   const url=typeof input==='string'?input:input instanceof Request?input.url:String(input);
   if(url.endsWith('/v1/saved-values')&&!(window as any).__savedValuesReady)return new Response(JSON.stringify({message:'Endpoint not found'}),{status:404,headers:{'content-type':'application/json'}});
   return original(input,init);
  };
 });
 await page.goto('/settings/saved-values');
 await expect(page.getByText('Saved values are not available on this server yet. Update the server, then retry.')).toBeVisible();
 await expect(page.getByText('No saved values yet.')).toHaveCount(0);
 await expect(page.getByLabel('Saved value name')).toBeDisabled();
 if(capture)await page.screenshot({path:join(capture,info.project.name+'-server-unavailable.png')});
 await page.evaluate(()=>{(window as any).__savedValuesReady=true;});
 await page.getByRole('button',{name:'Retry loading'}).click();
 await expect(page.getByLabel('Saved value name')).toBeEnabled();
 await expect(page.getByText('No saved values yet.')).toBeVisible();
});
