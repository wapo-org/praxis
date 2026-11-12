import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { open, chat, send, settled, OUT, TAG } from './l3-lib.mjs';
await mkdir(OUT, {recursive:true});
for (const scheme of ['light','dark']) {
  const {browser,page}=await open(chromium,{scheme,dpr:1});
  await chat(page,{model:'l3-150',title:'Formatting capture'});
  await send(page,'every element'); await settled(page);
  const message=page.getByTestId('agent-message-view').last();
  const height=await message.evaluate(el=>Math.ceil(el.getBoundingClientRect().height));
  await page.setViewportSize({width:1440,height:height+350});
  await page.getByTestId('chat-scroll-viewport').evaluate(el=>el.scrollTop=0);
  await page.waitForTimeout(500);
  await message.screenshot({path:`${OUT}/${TAG}-format-${scheme}.png`});
  if(scheme==='light' && TAG !== 'before') {
    const block=page.getByTestId('markdown-code-block').first();
    await block.getByRole('button',{name:'Wrap lines'}).click();
    await block.screenshot({path:`${OUT}/${TAG}-code-wrap.png`});
    await page.getByTestId('user-message-bubble').hover();
    await page.getByTestId('user-message-bubble').screenshot({path:`${OUT}/${TAG}-user-copy.png`});
  }
  await browser.close();
}
