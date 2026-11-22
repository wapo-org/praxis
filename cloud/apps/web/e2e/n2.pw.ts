import { openSignedInPage, signedInTest as test } from './sign-in';
import {expect,type Page} from '@playwright/test';
// WP-N2: the shadcn code block port, fence features, per-block wrap, the wrap scroll jump and streaming.
const F='```';
const longLine=`const url = 'https://example.com/api/v1/articles?fields=title,author,published_at,reading_time,tags&sort=-published_at&page[size]=50&filter[status]=published&include=author';`;
const fence=(lang:string,...lines:string[])=>[F+lang,...lines,F].join('\n');
const para=(n:number)=>`Paragraph ${n}. Reading time estimates are usually based on an average adult reading speed of about 238 words per minute; technical prose is slower.`;
const DOC=[
  '## Reading time',para(1),para(2),
  fence('python','for a in articles:','    print(f"{a.title} — ~{a.reading_time_minutes()} min read")'),
  '## Long lines above',para(3),fence('ts',longLine,longLine.replace('articles','authors')),para(4),
  '## Bash / Terminal',fence('bash','# Build and deploy with checks','set -e','npm ci','npm run build','du -sh dist/'),
  '## Very Long Line Code Test',fence('ts',longLine),
  para(5),para(6),para(7),para(8),para(9),para(10),
].join('\n\n');

async function chat(page:Page,text:string,script='text'){
  const id=await page.evaluate(async({text,script})=>{
    // @ts-expect-error Vite source import.
    const {apiClient}=await import('/src/lib/api.ts');
    const chat=await apiClient.createChat({title:'N2 code blocks'});
    await apiClient.startRun({chatId:chat.id,text,script});return chat.id;
  },{text,script});
  await page.goto(`/c/${id}`);
  await page.getByTestId('turn-copy-button').last().waitFor({timeout:30000});
  return id;
}
const block=(page:Page,text:string)=>page.getByTestId('markdown-code-block').filter({hasText:text}).last();

test('wrap is per block: the button shows only on a block that overflows, and toggling it wraps that block alone',async({page})=>{
  await openSignedInPage(page);await chat(page,DOC);
  const short=block(page,'Build and deploy'),long=block(page,'include=author'),two=block(page,'authors?fields');
  await expect(long.getByTestId('code-wrap-button')).toBeVisible();
  await expect(short.getByTestId('code-wrap-button')).toHaveCount(0);
  await expect(page.getByTestId('markdown-code-block').filter({hasText:'reading_time_minutes'}).getByTestId('code-wrap-button')).toHaveCount(0);
  await long.getByTestId('code-wrap-button').click();
  await expect(long.getByTestId('code-wrap-button')).toHaveAttribute('aria-pressed','true');
  await expect(two.getByTestId('code-wrap-button')).toHaveAttribute('aria-pressed','false');
  await expect(page.locator('[data-testid=code-wrap-button][aria-pressed=true]')).toHaveCount(1);
  expect(await long.locator('pre').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  expect(await two.locator('pre').evaluate(el=>el.scrollWidth>el.clientWidth+1)).toBe(true);
  // Still shown while wrapped (nothing overflows then), and nothing is remembered across a reload.
  await long.getByTestId('code-wrap-button').click();
  await expect(long.getByTestId('code-wrap-button')).toHaveAttribute('aria-pressed','false');
  await long.getByTestId('code-wrap-button').click();
  expect(await page.evaluate(()=>sessionStorage.getItem('praxis-code-wrap'))).toBeNull();
  await page.reload();await page.getByTestId('turn-copy-button').last().waitFor();
  await expect(page.locator('[data-testid=code-wrap-button][aria-pressed=true]')).toHaveCount(0);
});

test('wrapping a block mid-page keeps its button within 1 px; only the content below moves (N-ref/04)',async({page})=>{
  await openSignedInPage(page);await chat(page,DOC);
  const viewport=page.getByTestId('chat-scroll-viewport');
  const target=block(page,'include=author');
  await viewport.hover();
  // Scroll up with the wheel, as a person does, until the block sits mid-viewport.
  for(let i=0;i<40;i++){
    const top=await target.evaluate(e=>e.getBoundingClientRect().top);
    if(top>320&&top<520)break;
    await page.mouse.wheel(0,top>520?Math.min(300,top-420):-Math.min(300,420-top));await page.waitForTimeout(100);
  }
  await page.waitForTimeout(400);
  const above=page.getByRole('heading',{name:'Bash / Terminal'});
  for(const pressed of ['true','false']){
    const before={button:await target.getByTestId('code-wrap-button').evaluate(e=>e.getBoundingClientRect().top),above:await above.evaluate(e=>e.getBoundingClientRect().top),height:await target.evaluate(e=>e.getBoundingClientRect().height)};
    await page.evaluate(()=>{const b=document.querySelector('[data-testid=chat-scroll-viewport]')!;(window as any).__tops=[];const btns=[...document.querySelectorAll('[data-testid=code-wrap-button]')];const t0=performance.now();const tick=()=>{(window as any).__tops.push(btns.map(x=>x.getBoundingClientRect().top));if(performance.now()-t0<700)requestAnimationFrame(tick);};requestAnimationFrame(tick);void b;});
    await target.getByTestId('code-wrap-button').click();
    await expect(target.getByTestId('code-wrap-button')).toHaveAttribute('aria-pressed',pressed);
    await page.waitForTimeout(800);
    const after={button:await target.getByTestId('code-wrap-button').evaluate(e=>e.getBoundingClientRect().top),above:await above.evaluate(e=>e.getBoundingClientRect().top),height:await target.evaluate(e=>e.getBoundingClientRect().height)};
    expect(Math.abs(after.button-before.button)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.above-before.above)).toBeLessThanOrEqual(1);
    if(pressed==='true')expect(after.height).toBeGreaterThan(before.height+10);
    // Every frame in between, too: no transient jump.
    const frames=await page.evaluate(()=>(window as any).__tops as number[][]);
    const index=await page.evaluate(()=>[...document.querySelectorAll('[data-testid=code-wrap-button]')].findIndex(b=>b.closest('[data-testid=markdown-code-block]')!.textContent!.includes('include=author')&&!b.closest('[data-testid=markdown-code-block]')!.textContent!.includes('authors?')));
    for(const f of frames)expect(Math.abs(f[index]!-before.button)).toBeLessThanOrEqual(1);
  }
});

test('the fixture chat shows every fence feature',async({page})=>{
  await openSignedInPage(page);await chat(page,'Show me every code block feature','codeFeatures');
  const titled=block(page,'readingTime');
  await expect(titled.locator('[data-slot=code-block-title]')).toHaveText('src/lib/reading.ts');
  await expect(titled.locator('pre')).toHaveAttribute('data-numbered','true');
  expect(await titled.locator('[data-slot=code-block-line]').evaluateAll(ls=>ls.map((l,i)=>l.getAttribute('data-variant')==='highlighted'?i+1:0).filter(Boolean))).toEqual([2,5,6]);
  // Line numbers are CSS counters: shown, never in the text.
  expect(await titled.locator('[data-slot=code-block-line]').first().evaluate(l=>getComputedStyle(l,'::before').content)).toMatch(/counter|"1"|1/);
  expect(await titled.locator('pre').textContent()).not.toMatch(/^1/);
  expect(await block(page,'for a in articles').locator('pre').getAttribute('style')).toContain('counter-reset: line 39');
  const diff=block(page,'greet');
  await expect(diff.locator('[data-variant=added]')).toHaveCount(2);
  await expect(diff.locator('[data-variant=removed]')).toHaveCount(1);
  expect(await diff.locator('[data-variant=added]').first().textContent()).toBe('  const trimmed = name.trim();');
  expect(await diff.locator('[data-variant=added] span[style]').count()).toBeGreaterThan(2);
  const terminal=block(page,'npm run build');
  await expect(terminal.locator('[data-slot=code-block-title]')).toHaveText('Terminal');
  await expect(terminal.locator('[data-role=command]')).toHaveCount(2);
  expect(await terminal.locator('[data-role=output] span[style]').count()).toBeGreaterThan(0);
  expect(await terminal.locator('pre').textContent()).not.toContain('\u001b');
  const ansi=block(page,'starting server');
  expect(await ansi.locator('span[style]').count()).toBeGreaterThanOrEqual(3);
  await expect(block(page,'Nothing here is highlighted').locator('span[style]')).toHaveCount(0);
  await expect(block(page,'TypeError')).toHaveAttribute('data-variant','destructive');
  await expect(block(page,'TS2322')).toHaveAttribute('data-variant','destructive');
  const long=block(page,'item-01');
  await expect(long.locator('pre')).toHaveAttribute('data-collapsed','true');
  const collapsed=await long.evaluate(e=>e.getBoundingClientRect().height);
  await long.getByTestId('code-expand-button').click();
  await expect(long.getByTestId('code-expand-button')).toHaveText('Show less');
  expect(await long.evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThan(collapsed+200);
});

test('a selection copies blank lines and never line numbers, diff markers or prompts',async({page})=>{
  await openSignedInPage(page);
  await chat(page,['Blocks:',fence('ts showLineNumbers','const a = 1;','','const b = 2;'),fence('diff','-old','+new'),fence('terminal','$ ls','file.txt')].join('\n\n'));
  const select=(text:string)=>block(page,text).locator('pre').evaluate(pre=>{const r=document.createRange();r.selectNodeContents(pre);const s=getSelection()!;s.removeAllRanges();s.addRange(r);return s.toString();});
  expect((await select('const a')).replace(/\n$/,'')).toBe('const a = 1;\n\nconst b = 2;');
  expect((await select('old')).replace(/\n$/,'')).toBe('old\nnew');
  expect((await select('file.txt')).replace(/\n$/,'')).toBe('ls\nfile.txt');
});

test('a long block streams in small chunks without colour flicker or height going back',async({page})=>{
  await openSignedInPage(page);
  // The codeFeatures fixture streams ~4 characters every 6 ms; its last block is 36 lines (it collapses at 20).
  const id=await page.evaluate(async()=>{
    // @ts-expect-error Vite source import.
    const {apiClient}=await import('/src/lib/api.ts');return (await apiClient.createChat({title:'N2 streaming'})).id;
  });
  await page.goto(`/c/${id}`);await page.getByTestId('composer-input').waitFor();
  await page.evaluate(()=>{
    const samples:{h:number;coloured:number;text:number}[]=[];(window as any).__samples=samples;
    const tick=()=>{const b=[...document.querySelectorAll('[data-testid=markdown-code-block]')].find(x=>x.textContent!.includes('export const items'));if(b)samples.push({h:b.getBoundingClientRect().height,coloured:b.querySelectorAll('span[style]').length,text:b.querySelector('pre')!.textContent!.length});if(!(window as any).__stop)requestAnimationFrame(tick);};
    requestAnimationFrame(tick);
  });
  await page.evaluate(async(id)=>{
    // @ts-expect-error Vite source import.
    const {apiClient}=await import('/src/lib/api.ts');await apiClient.startRun({chatId:id,text:'Show me every code block feature',script:'codeFeatures'});
  },id);
  await page.getByTestId('turn-copy-button').last().waitFor({timeout:60000});
  await page.evaluate(()=>{(window as any).__stop=true;});
  const s=await page.evaluate(()=>(window as any).__samples as {h:number;coloured:number;text:number}[]);
  let drops=0,shrinks=0,grew=0;
  for(let i=1;i<s.length;i++){if(s[i]!.text>=s[i-1]!.text&&s[i-1]!.coloured>0&&s[i]!.coloured<s[i-1]!.coloured)drops++;if(s[i]!.h<s[i-1]!.h-0.5)shrinks++;if(s[i]!.h>s[i-1]!.h+0.5)grew++;}
  expect(grew).toBeGreaterThan(10);
  expect(drops).toBe(0);
  expect(shrinks).toBe(0);
  await expect(page.getByTestId('markdown-code-block').filter({hasText:'export const items'}).locator('pre')).toHaveAttribute('data-collapsed','true');
});
