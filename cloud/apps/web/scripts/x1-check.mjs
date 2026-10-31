import { chromium } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import assert from 'node:assert/strict';
const BASE=process.env.BASE??'http://127.0.0.1:5191';
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:402,height:874}});page.setDefaultTimeout(15000);
 await page.goto(BASE);await page.getByRole('button',{name:'Continue as local dev user'}).click();await page.getByTestId('chat-top-bar').waitFor();
 // Real registry install/update endpoints; fixture upstream changes its digest.
 const registry=await page.evaluate(async()=>{const {apiClient}=await import('/src/lib/api.ts');for(const connector of (await apiClient.listConnectors()).items)if(connector.name.startsWith('X1'))await apiClient.deleteConnector(connector.id);for(const provider of (await apiClient.listProviders()).items)if(provider.name==='X1 Provider')await apiClient.deleteProvider(provider.id);for(const skill of (await apiClient.listSkills()).items)if(skill.name.startsWith('x1-'))await apiClient.deleteSkill(skill.id);const r=await apiClient.createSkillRegistry({name:'X1 Registry',url:'https://example.com/x1/skills'});const installed=await apiClient.installRegistrySkill(r.id,'entry');return {...r,before:installed.document};});
 await page.request.post(`${BASE}/__test/x1/advance`,{data:{registryId:registry.id}});
 await page.goto(`${BASE}/settings/skills`);await page.getByText('Update available',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Update x1-registry',exact:true}).click();await page.getByText('All registry skills are up to date.',{exact:true}).waitFor();
 assert.notEqual(await page.evaluate(async()=>{const {apiClient}=await import('/src/lib/api.ts');return (await apiClient.listSkills()).items.find(s=>s.name==='x1-registry').document;}),registry.before);
 // Upload real zip bytes through local upload + archive import; verify API persisted document.
 await page.getByRole('button',{name:'Import skill',exact:true}).click();
 const zip=zipSync({'SKILL.md':strToU8('---\nname: x1-archive\ndescription: Imported archive\n---\nArchive instructions'),'reference.txt':strToU8('Supporting file')});
 await page.getByLabel('Skill archive',{exact:true}).setInputFiles({name:'x1.zip',mimeType:'application/zip',buffer:Buffer.from(zip)});
 await page.getByRole('status').filter({hasText:'Imported x1-archive.'}).waitFor();
 assert.ok(await page.evaluate(async()=>{const {apiClient}=await import('/src/lib/api.ts');return (await apiClient.listSkills()).items.some(s=>s.name==='x1-archive');}));
 // Invalid archive surfaces actual API error and does not invent another skill.
 await page.getByLabel('Skill archive',{exact:true}).setInputFiles({name:'broken.zip',mimeType:'application/zip',buffer:Buffer.from('not a zip')});await page.getByRole('alert').first().waitFor();
 await page.goto(`${BASE}/settings/connectors/registry`);await page.getByRole('searchbox',{name:'Search MCP registry'}).fill('Docs');await page.getByText('X1 Docs',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Add',exact:true}).click();await page.getByRole('status').filter({hasText:'X1 Docs · Connected'}).waitFor();
 // Test connection performs real provider discovery + streamed tool/vision probe through local API.
 await page.goto(`${BASE}/settings`);await page.getByRole('button',{name:'Add provider',exact:true}).click();
 await page.getByRole('button',{name:'Provider preset',exact:true}).click();await page.getByRole('menuitem',{name:'Custom',exact:true}).press('Enter');
 await page.getByRole('textbox',{name:'Name',exact:true}).fill('X1 Provider');await page.getByRole('textbox',{name:'Base URL',exact:true}).fill('https://example.com/x1/v1');
 await page.getByLabel(/^Flavor/).selectOption('openAIChat');
 await page.getByPlaceholder('Model ID',{exact:true}).fill('x1-model');
 await page.getByText('Tool calling',{exact:true}).click();
 assert.equal(await page.getByRole('switch',{name:'Tool calling',exact:true}).isChecked(),false);
 await page.getByRole('checkbox',{name:/Allow test messages/}).check();
 await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.getByRole('status').filter({hasText:'Streaming: supported'}).waitFor();
 assert.equal(await page.getByRole('switch',{name:'Tool calling',exact:true}).isChecked(),true);
 await page.getByRole('button',{name:'Save provider',exact:true}).click();await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
 assert.equal(await page.evaluate(async()=>{const {apiClient}=await import('/src/lib/api.ts');return (await apiClient.listProviders()).items.find(p=>p.name==='X1 Provider').capabilities.tools;}),true);
 console.log('PASS: live local API skill update/apply; zip upload/import and invalid archive error; API MCP registry search/add/health; discovery + streamed capability probe and saved toggles (deterministic test upstreams)');
}finally{await browser.close();}
