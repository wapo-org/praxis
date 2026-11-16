import {chromium,webkit} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';

const [phase='after',mode='wrap',which='chrome']=process.argv.slice(2);
const base=process.env.N2_BASE??'http://127.0.0.1:5262';
const dir=`${process.env.HOME}/.praxis-agent-state/cloud/design/N/N2/${phase}/${mode}-${which}`;
mkdirSync(dir,{recursive:true});
const F='```';

const longLine=`const url = 'https://example.com/api/v1/articles?fields=title,author,published_at,reading_time,tags&sort=-published_at&page[size]=50&filter[status]=published&include=author,comments';`;
const para=(n)=>`Paragraph ${n}. Reading time estimates are usually based on an average adult reading speed of about 238 words per minute; technical prose is slower.`;
// The owner's shape (N-ref/04): prose, a Python block, blocks with long lines above, the short Bash block, then more.
const fence=(lang,...lines)=>[F+lang,...lines,F].join('\n');
const WRAP_DOC=[
  '## Reading time', para(1), para(2),
  fence('python','for a in articles:','    print(f"{a.title} — ~{a.reading_time_minutes()} min read")'),
  '## Long lines above', para(3),
  fence('ts',longLine,longLine.replace('articles','authors')),
  para(4),
  fence('json',JSON.stringify({query:'reading time',filters:{status:'published',tags:['alpha','beta','gamma','delta']},page:{size:50,cursor:'eyJpZCI6MTIzNDU2Nzg5MCwidCI6IjIwMjYtMTEtMTMifQ'}})),
  '## Bash / Terminal',
  fence('bash','# Build and deploy with checks','set -e','npm ci','npm run lint && npm run test -- --coverage','npm run build','echo "Build size:"','du -sh dist/','rsync -avz --delete dist/ user@prod:/var/www/app/','echo "✅ Deployed at $(date -u +%FT%TZ)"'),
  '## Very Long Line Code Test',
  fence('ts',longLine),
  para(5), para(6), para(7), para(8),
].join('\n\n');

const LONG_BLOCK=[`${F}ts`,...Array.from({length:60},(_,i)=>`export const value${i} = computeSomething(${i}, 'label-${i}', { retries: ${i%5}, verbose: ${i%2===0} }); // line ${i+1}`),F].join('\n');

async function open(){
  const type=which==='webkit'?webkit:chromium;
  const browser=await type.launch(which==='webkit'?{headless:false}:{channel:'chrome',headless:false});
  const ctx=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir,size:{width:1440,height:900}},serviceWorkers:'allow'});
  if(process.env.N2_THEME)await ctx.addInitScript(t=>localStorage.setItem('praxis-theme',t),process.env.N2_THEME);
  const page=await ctx.newPage();
  await page.goto(base);
  await page.getByRole('button',{name:'Continue as local dev user'}).click();
  await page.getByTestId('chat-top-bar').waitFor();
  return {browser,ctx,page};
}
const chatWith=(page,text,script='text',title='N2 capture')=>page.evaluate(async({text,script,title})=>{
  const {apiClient}=await import('/src/lib/api.ts');
  const chat=await apiClient.createChat({title});
  await apiClient.startRun({chatId:chat.id,text,script});return chat.id;
},{text,script,title});
const settle=(page,ms=400)=>page.waitForTimeout(ms);

/** Per-frame tops of the given elements for `ms` after `act`, as offsets from where they were before it. */
async function trackTops(page,selectors,act,ms=900){
  await page.evaluate(({selectors,ms})=>{
    const els=selectors.map(s=>typeof s==='string'?document.querySelector(s):null);
    const start=els.map(e=>e?.getBoundingClientRect().top??NaN);
    const frames=[];const t0=performance.now();
    window.__n2frames=frames;
    const tick=()=>{frames.push(els.map((e,i)=>+((e?.getBoundingClientRect().top??NaN)-start[i]).toFixed(2)));if(performance.now()-t0<ms)requestAnimationFrame(tick);};
    requestAnimationFrame(tick);
  },{selectors,ms});
  await act();
  await page.waitForTimeout(ms+150);
  return page.evaluate(()=>window.__n2frames);
}

async function wrapMode(){
  const {browser,ctx,page}=await open();
  const results={browser:which,phase};
  try{
    const id=await chatWith(page,WRAP_DOC);
    await page.goto(`${base}/c/${id}`);await page.getByTestId('turn-copy-button').last().waitFor({timeout:30000});
    await settle(page,800);
    const blocks=page.getByTestId('markdown-code-block');
    const bashIndex=await blocks.evaluateAll(els=>els.findIndex(e=>e.textContent.includes('Build and deploy')));
    const longIndex=await blocks.evaluateAll(els=>els.findIndex(e=>e.textContent.includes('page[size]=50&filter[status]=published&include')&&!e.textContent.includes('authors')&&e.querySelectorAll('[data-slot=code-block-line], span').length<40));
    // Scroll with the wheel (as a person does) until the Bash block sits mid-viewport.
    const viewport=page.getByTestId('chat-scroll-viewport');
    await viewport.hover();
    for(let i=0;i<60;i++){
      const top=await blocks.nth(bashIndex).evaluate(e=>e.getBoundingClientRect().top);
      if(top>300&&top<520)break;
      await page.mouse.wheel(0,top>520?Math.min(400,top-400):-Math.min(400,400-top));await page.waitForTimeout(120);
    }
    await settle(page,600);
    const mark=(i,name)=>blocks.nth(i).evaluate((e,name)=>{e.setAttribute('data-n2',name);},name);
    await mark(bashIndex,'bash');await mark(longIndex,'long');
    await page.evaluate(()=>{const h=[...document.querySelectorAll('h2')].find(h=>h.textContent.includes('Bash'));h?.setAttribute('data-n2','bash-heading');const p=[...document.querySelectorAll('p')].find(p=>p.textContent.startsWith('Paragraph 5'));p?.setAttribute('data-n2','below');});
    await page.screenshot({path:`${dir}/1-before-toggle.png`});
    const bashWrap=page.locator('[data-n2=bash] [data-testid=code-wrap-button]');
    results.bashWrapButtons=await bashWrap.count();
    results.scrollTopBefore=await viewport.evaluate(e=>e.scrollTop);
    if(results.bashWrapButtons){
      const frames=await trackTops(page,['[data-n2=bash] [data-testid=code-wrap-button]','[data-n2=bash-heading]','[data-n2=below]'],()=>bashWrap.click());
      results.bashToggle={maxButtonShift:Math.max(...frames.map(f=>Math.abs(f[0]))),finalButtonShift:frames.at(-1)[0],finalHeadingShift:frames.at(-1)[1],finalBelowShift:frames.at(-1)[2],frames:frames.length};
      results.scrollTopAfterBash=await viewport.evaluate(e=>e.scrollTop);
      await page.screenshot({path:`${dir}/2-after-bash-toggle.png`});
      results.wrappedBlocksAfterBashToggle=await page.locator('[data-testid=markdown-code-block][data-wrap=true], [data-testid=markdown-code-block] pre[data-wrap]').count();
    }
    // A block that does overflow, scrolled mid-page: wrapping grows it; nothing above may move.
    await blocks.nth(longIndex).evaluate(e=>{const v=document.querySelector('[data-testid=chat-scroll-viewport]');v.scrollTop+=e.getBoundingClientRect().top-420;});
    await page.mouse.wheel(0,-1);await settle(page,600);
    const longWrap=page.locator('[data-n2=long] [data-testid=code-wrap-button]');
    results.longWrapButtons=await longWrap.count();
    if(results.longWrapButtons){
      const above='[data-n2=long]';
      const frames=await trackTops(page,['[data-n2=long] [data-testid=code-wrap-button]',above,'[data-n2=below]'],()=>longWrap.click());
      results.longToggleOn={maxButtonShift:Math.max(...frames.map(f=>Math.abs(f[0]))),finalButtonShift:frames.at(-1)[0],blockTopShift:frames.at(-1)[1],belowShift:frames.at(-1)[2]};
      await page.screenshot({path:`${dir}/3-long-wrapped.png`});
      const back=await trackTops(page,['[data-n2=long] [data-testid=code-wrap-button]',above,'[data-n2=below]'],()=>longWrap.click());
      results.longToggleOff={maxButtonShift:Math.max(...back.map(f=>Math.abs(f[0]))),finalButtonShift:back.at(-1)[0],blockTopShift:back.at(-1)[1],belowShift:back.at(-1)[2]};
      results.wrappedBlocksAfterLongToggle=await page.locator('[data-testid=code-wrap-button][aria-pressed=true]').count();
    }
  } finally {writeFileSync(`${dir}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));await ctx.close();await browser.close();}
}

async function lookMode(){
  for(const theme of ['light','dark']){
    process.env.N2_THEME=theme;
    const {browser,ctx,page}=await open();
    try{
      const fixture=process.env.N2_SCRIPT!=='text';
      const id=fixture?await chatWith(page,'Show me every code block feature','codeFeatures','Code block features'):await chatWith(page,WRAP_DOC);
      await page.goto(`${base}/c/${id}`);await page.getByTestId('turn-copy-button').last().waitFor({timeout:60000});await settle(page,1200);
      const blocks=page.getByTestId('markdown-code-block');
      const n=await blocks.count();
      for(let i=0;i<n;i++){
        await blocks.nth(i).evaluate(e=>e.scrollIntoView({block:'center'}));await settle(page,250);
        await blocks.nth(i).screenshot({path:`${dir}/${theme}-block-${String(i).padStart(2,'0')}.png`});
      }
      await blocks.first().evaluate(e=>e.scrollIntoView({block:'start'}));await page.mouse.wheel(0,-200);await settle(page,500);
      await page.screenshot({path:`${dir}/${theme}-page.png`});
    } finally {await ctx.close();await browser.close();}
  }
}

/** A long fenced block streamed in small chunks: frames, per-frame line counts, and heights. */
async function streamMode(){
  const {browser,ctx,page}=await open();
  const results={browser:which,phase};
  try{
    // The codeFeatures fixture streams ~4 characters every 6 ms; its last block is 36 lines.
    const id=await page.evaluate(async()=>{const {apiClient}=await import('/src/lib/api.ts');return (await apiClient.createChat({title:'Code block streaming'})).id;});
    await page.goto(`${base}/c/${id}`);await page.getByTestId('composer-input').waitFor();await settle(page,600);
    await page.evaluate(()=>{
      const samples=[];window.__n2stream=samples;let last=null;
      const tick=()=>{
        const block=[...document.querySelectorAll('[data-testid=markdown-code-block]')].find(b=>b.textContent.includes('export const items'));
        if(block){const lines=block.querySelectorAll('[data-slot=code-block-line], pre code > span').length;const coloured=block.querySelectorAll('pre code span[style]').length;const h=block.getBoundingClientRect().height;const text=block.querySelector('pre')?.textContent.length??0;
          if(!last||last.h!==h||last.lines!==lines||last.coloured!==coloured)samples.push(last={t:+performance.now().toFixed(1),h:+h.toFixed(1),lines,coloured,text});}
        if(!window.__n2stop)requestAnimationFrame(tick);
      };requestAnimationFrame(tick);
    });
    await page.evaluate(async(id)=>{const {apiClient}=await import('/src/lib/api.ts');await apiClient.startRun({chatId:id,text:'Show me every code block feature',script:'codeFeatures'});},id);
    await page.waitForTimeout(3500);await page.screenshot({path:`${dir}/streaming.png`});
    await page.getByTestId('turn-copy-button').last().waitFor({timeout:60000});await settle(page,800);
    await page.evaluate(()=>{window.__n2stop=true;});
    const samples=await page.evaluate(()=>window.__n2stream);
    // A drop in coloured spans while the text only grows is a colour flicker; a drop in height is a jump back.
    let flickers=0,shrinks=0;for(let i=1;i<samples.length;i++){if(samples[i].text>=samples[i-1].text&&samples[i].coloured<samples[i-1].coloured&&samples[i].coloured>0)flickers++;if(samples[i].h<samples[i-1].h-0.5)shrinks++;}
    Object.assign(results,{samples:samples.length,colourDrops:flickers,heightShrinks:shrinks,maxHeightStep:Math.max(0,...samples.slice(1).map((s,i)=>s.h-samples[i].h)),final:samples.at(-1)});
    writeFileSync(`${dir}/samples.json`,JSON.stringify(samples));
    await page.screenshot({path:`${dir}/finished.png`});
  } finally {writeFileSync(`${dir}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));await ctx.close();await browser.close();}
}

/** Floating actions on hover, the focus ring on the block, the copy check, Show more. */
async function statesMode(){
  const {browser,ctx,page}=await open();
  const results={browser:which};
  try{
    await ctx.grantPermissions(['clipboard-read','clipboard-write']).catch(()=>{});
    const id=await chatWith(page,'Show me every code block feature','codeFeatures','Code block features');
    await page.goto(`${base}/c/${id}`);await page.getByTestId('turn-copy-button').last().waitFor({timeout:60000});await settle(page,800);
    const ansi=page.getByTestId('markdown-code-block').filter({hasText:'starting server'});
    await ansi.evaluate(e=>e.scrollIntoView({block:'center'}));await settle(page,300);
    const actions=ansi.locator('[data-slot=code-block-actions]');
    results.floatingOpacityAtRest=await actions.evaluate(e=>getComputedStyle(e).opacity);
    await ansi.hover();await settle(page,300);
    results.floatingOpacityOnHover=await actions.evaluate(e=>getComputedStyle(e).opacity);
    await ansi.screenshot({path:`${dir}/floating-hover.png`});
    await ansi.getByTestId('code-copy-button').click();await settle(page,150);
    results.copyLabel=await ansi.getByTestId('code-copy-button').getAttribute('aria-label');
    results.live=await ansi.locator('[aria-live=polite]').textContent();
    results.clipboard=await page.evaluate(()=>navigator.clipboard.readText()).catch(e=>'unreadable: '+e.message);
    await ansi.screenshot({path:`${dir}/copied.png`});
    await page.waitForTimeout(2100);
    results.copyLabelAfter2s=await ansi.getByTestId('code-copy-button').getAttribute('aria-label');
    const terminal=page.getByTestId('markdown-code-block').filter({hasText:'npm run build'});
    await terminal.getByTestId('code-copy-button').click();await settle(page,150);
    results.terminalClipboard=await page.evaluate(()=>navigator.clipboard.readText()).catch(e=>'unreadable: '+e.message);
    // Keyboard focus on the code: the ring is on the block.
    await page.mouse.move(5,5);
    const titled=page.getByTestId('markdown-code-block').filter({hasText:'readingTime'});
    await titled.evaluate(e=>e.scrollIntoView({block:'center'}));
    await titled.getByTestId('code-copy-button').focus();await page.keyboard.press('Tab');await settle(page,200);
    results.focusedSlot=await page.evaluate(()=>document.activeElement?.getAttribute('data-slot'));
    results.blockOutline=await titled.evaluate(e=>getComputedStyle(e).outlineStyle+' '+getComputedStyle(e).outlineWidth);
    const box=await titled.boundingBox();
    await page.screenshot({path:`${dir}/focus-ring.png`,clip:{x:box.x-10,y:box.y-10,width:box.width+20,height:box.height+20}});
    const long=page.getByTestId('markdown-code-block').filter({hasText:'item-01'});
    await long.evaluate(e=>e.scrollIntoView({block:'center'}));await settle(page,200);
    await long.getByTestId('code-expand-button').click();await settle(page,400);
    await long.screenshot({path:`${dir}/expanded.png`});
  } finally {writeFileSync(`${dir}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));await ctx.close();await browser.close();}
}

if(mode==='states')await statesMode();
else if(mode==='wrap')await wrapMode();
else if(mode==='look')await lookMode();
else if(mode==='stream')await streamMode();
else throw new Error('mode: wrap | look | stream');
