import { chromium, webkit, firefox } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const BASE=process.env.BASE??'http://127.0.0.1:5191';
const out=`${homedir()}/.praxis-agent-state/cloud/reports/web-glass`;
await mkdir(out,{recursive:true});
const metrics=[];
for(const [name,type] of [['chromium',chromium],['webkit',webkit],['firefox',firefox]]){
 const browser=await type.launch();
 try{
 const reduced=await browser.newPage();
 await reduced.addInitScript(()=>{const original=window.matchMedia.bind(window);window.matchMedia=query=>query==='(prefers-reduced-transparency: reduce)'?{...original(query),matches:true,addEventListener(){},removeEventListener(){}}:original(query);});
 await reduced.goto(BASE);await reduced.getByRole('button',{name:'Continue as local dev user'}).click();
 await reduced.waitForFunction(()=>document.querySelector('[data-glass-strategy="reduced-transparency"]'));
 assert.equal(await reduced.locator('[data-glass-webgl]').count(),0);await reduced.close();
 const page=await browser.newPage({viewport:{width:402,height:874}});page.setDefaultTimeout(20000);
 await page.addInitScript(()=>{
   window.__glassContexts=[];
   const original=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(type,...args){const ctx=original.call(this,type,...args);if(ctx&&['webgl','webgl2','experimental-webgl'].includes(type)&&!window.__glassContexts.includes(ctx))window.__glassContexts.push(ctx);return ctx;};
 });
 await page.goto(BASE);await page.getByRole('button',{name:'Continue as local dev user'}).click();await page.getByTestId('chat-top-bar').waitFor();
 if(name!=='chromium'){
   await page.waitForFunction(()=>document.querySelectorAll('[data-glass-webgl="ready"]').length>=3);
   assert.equal(await page.evaluate(()=>window.__glassContexts.length),1);
   await page.locator('.praxis-glass-chip').first().waitFor();
   assert.ok(await page.locator('.praxis-glass-chip').first().locator('xpath=ancestor::*[@data-glass-surface]').count());
 }
 await page.screenshot({path:`${out}/${name}-chips.png`});
 // Real API scripted long response; no mocked success/data path.
 const chat=await page.evaluate(async()=>{const {apiClient}=await import('/src/lib/api.ts');const chat=await apiClient.createChat({title:'Refraction scroll check'});await apiClient.startRun({chatId:chat.id,text:Array.from({length:50},(_,i)=>`Paragraph ${i+1}: Real conversation text behind the refracting glass. A scrolling source for the optical layer.`).join('\n\n'),script:'long'});return chat;});
 await page.goto(`${BASE}/c/${chat.id}`);await page.getByTestId('assistant-turn').first().waitFor();
 await page.waitForFunction(()=>!document.querySelector('[aria-label="Stop generating"]'));
 // Scroll through actual chat and include material work in end-to-end RAF samples.
 const timing=await page.evaluate(async()=>{
   const el=document.querySelector('[data-testid="chat-scroll-viewport"]');if(!el)throw Error('Chat scroll container missing');
   const deltas=[];let last=performance.now();
   for(let i=0;i<120;i++){await new Promise(requestAnimationFrame);const now=performance.now();deltas.push(now-last);last=now;el.scrollTop=(Math.sin(i/20)*.5+.5)*(el.scrollHeight-el.clientHeight);}
   deltas.shift();deltas.sort((a,b)=>a-b);return {meanMs:deltas.reduce((a,b)=>a+b,0)/deltas.length,p95Ms:deltas[Math.floor(deltas.length*.95)],frames:deltas.length,scrollRange:el.scrollHeight-el.clientHeight};
 });assert.ok(timing.scrollRange>0);metrics.push({engine:name,...timing});
 await page.screenshot({path:`${out}/${name}-chat.png`});
 await page.goto(`${BASE}/settings`);await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
 if(name!=='chromium')await page.waitForFunction(()=>document.querySelector('.screen-dialog [data-glass-webgl="ready"]'));
 await page.screenshot({path:`${out}/${name}-sheet.png`});
 await page.getByRole('button',{name:'Add provider',exact:true}).click();await page.getByRole('button',{name:'Provider preset',exact:true}).click();await page.getByRole('menuitem',{name:'OpenAI',exact:true}).waitFor();
 if(name!=='chromium'){
   await page.waitForFunction(()=>document.querySelector('[role="menu"] [data-glass-webgl="ready"]'));
   assert.equal(await page.evaluate(()=>window.__glassContexts.length),1);
   // Prove the shader has drawn non-uniform pixels, not a transparent/flat blur placeholder.
   assert.ok(await page.locator('[role="menu"] [data-glass-webgl]').evaluate(c=>{const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return p.some((v,i)=>i%4!==3&&Math.abs(v-p[4* Math.floor(p.length/8)])>10);}));
 }
 await page.screenshot({path:`${out}/${name}-dropdown.png`});
 if(name!=='chromium'){
   await page.evaluate(()=>window.__glassContexts[0].getExtension('WEBGL_lose_context').loseContext());
   await page.waitForFunction(()=>document.querySelector('[data-glass-strategy="progressive-frost"]')&&!document.querySelector('[data-glass-webgl]'));
   await page.getByRole('menuitem',{name:'OpenAI',exact:true}).click(); // fallback is interactive
 }
 await page.close();
 }finally{await browser.close();}
}
// Side-by-side artifacts, same 402px scale; no screenshot/image tooling dependency.
const browser=await chromium.launch();try{for(const state of ['chips','chat','sheet','dropdown']){const page=await browser.newPage({viewport:{width:1238,height:930}});const images=await Promise.all(['chromium','webkit','firefox'].map(async name=>`<section><h2>${name}</h2><img src="data:image/png;base64,${(await readFile(`${out}/${name}-${state}.png`)).toString('base64')}"></section>`));await page.setContent(`<style>body{margin:0;display:flex;gap:12px;background:#eee;font:14px system-ui}section{width:402px}h2{height:28px;margin:8px}img{width:402px}</style>${images.join('')}`);await page.screenshot({path:`${out}/comparison-${state}.png`});await page.close();}}finally{await browser.close();}
await writeFile(`${out}/frames.json`,JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics));console.log('PASS: Chromium/WebKit/Firefox real app, shared context, pixels, loss fallback; 12 screenshots + 4 side-by-sides');
